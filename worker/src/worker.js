// ---------- worker entry: router ----------
import { json, text, rj, b64ToBuf } from "./util.js";
import { handleUpdate } from "./bot.js";
import { cronCheck, getTask, putTask } from "./tasks.js";
import { sendMsg, sendDoc } from "./tg.js";
import * as DB from "./db.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "GET" && (p === "/" || p === "/healthz")) {
        return text("✅ opencode telegram gateway is up");
      }

      if (p === "/tg/webhook" && req.method === "POST") {
        if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TG_WEBHOOK_SECRET) {
          return text("forbidden", 403);
        }
        const u = await req.json();
        ctx.waitUntil(dedupAndHandle(env, u));
        return text("ok");
      }

      if (p.startsWith("/agent/")) return await agentRoute(env, req, url, ctx);

      return text("not found", 404);
    } catch (e) {
      console.error("fetch", p, String(e));
      return json({ ok: false, error: String(e) }, 500);
    }
  },

  async scheduled(ev, env, ctx) {
    ctx.waitUntil(cronCheck(env).catch((e) => console.error("cron", String(e))));
  },
};

async function dedupAndHandle(env, u) {
  const last = Number((await env.KV.get("g:last_upd")) || 0);
  if (u.update_id && u.update_id <= last) return;
  await env.KV.put("g:last_upd", String(u.update_id || Date.now()));
  await handleUpdate(env, u);
}

async function authTask(env, req, url) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const id = req.headers.get("x-task-id") || url.searchParams.get("task") || "";
  if (!token || !id) return null;
  const t = await getTask(env, id);
  if (!t || t.token !== token) return null;
  return t;
}

async function agentRoute(env, req, url, ctx) {
  const p = url.pathname;

  if (p === "/agent/config" && req.method === "GET") {
    const t = await authTask(env, req, url);
    if (!t) return json({ ok: false, error: "unauthorized" }, 401);
    return json({
      ok: true,
      task_id: t.id,
      opencode_key: env.OC_API_KEY,
      poll_s: 15,
      heartbeat_min: Number(t.hb_min || env.HB_MIN || 15),
      idle_min: Number(t.idle_min || env.IDLE_MIN || 60),
      worker_url: env.WORKER_PUBLIC_URL,
    });
  }

  const t = await authTask(env, req, url);
  if (!t) return json({ ok: false, error: "unauthorized" }, 401);

  if (p === "/agent/poll" && req.method === "GET") {
    const fups = t.followups || [];
    const kill = !!t.kill, end = !!t.end;
    t.followups = []; t.kill = false; t.end = false;
    await putTask(env, t);
    return json({
      ok: true, kill, end,
      followups: fups.map((f) => ({
        text: f.text || "",
        files: (f.files || []).map((x) => ({ name: x.name, url: `${env.WORKER_PUBLIC_URL}/agent/file/${x.key}` })),
      })),
    });
  }

  if (p === "/agent/register" && req.method === "POST") {
    const b = await rj(req);
    t.run_id = b.run_id || null;
    t.status = "running";
    t.updated = Date.now();
    await putTask(env, t);
    ctx.waitUntil(sendMsg(env, t.chat, `▶️ تسک ${t.id} روی GitHub Actions شروع شد.`));
    return json({ ok: true });
  }

  if (p === "/agent/message" && req.method === "POST") {
    const b = await rj(req);
    const txt = String(b.text || "").slice(0, 60000);
    ctx.waitUntil(sendMsg(env, t.chat, `🤖 [${t.id}]\n${txt || "(پاسخ متنی خالی بود)"}`));
    return json({ ok: true });
  }

  if (p === "/agent/status" && req.method === "POST") {
    const b = await rj(req);
    ctx.waitUntil(sendMsg(env, t.chat, `⏳ [${t.id}] ${String(b.text || "هنوز در حال اجراست...")}`));
    return json({ ok: true });
  }

  if (p === "/agent/done" && req.method === "POST") {
    const b = await rj(req);
    t.status = "done"; t.finished = Date.now();
    await putTask(env, t);
    ctx.waitUntil(sendMsg(env, t.chat, `✅ تسک ${t.id} تمام شد.${b.text ? "\n" + String(b.text).slice(0, 500) : ""}`));
    return json({ ok: true });
  }

  if (p === "/agent/fail" && req.method === "POST") {
    const b = await rj(req);
    t.status = "failed"; t.error = String(b.text || "agent error").slice(0, 500); t.finished = Date.now();
    await putTask(env, t);
    ctx.waitUntil(sendMsg(env, t.chat, `⚠️ تسک ${t.id} خطا داد:\n${t.error}`));
    return json({ ok: true });
  }

  if (p === "/agent/upload" && req.method === "POST") {
    const fd = await req.formData();
    const f = fd.get("file");
    if (!f || typeof f === "string") return json({ ok: false, error: "no file field" }, 400);
    if (f.size > 45 * 1024 * 1024) return json({ ok: false, error: "file larger than 45MB" }, 400);
    const cap = String(fd.get("caption") || "");
    const bytes = await f.arrayBuffer();
    const name = f.name || "file.bin";
    const r = await sendDoc(env, t.chat, bytes, name, `📎 [${t.id}] ${name}${cap ? "\n" + cap : ""}`);
    return json({ ok: !!r.ok, error: r.ok ? undefined : r.description });
  }

  if (p.startsWith("/agent/file/") && req.method === "GET") {
    const key = decodeURIComponent(p.slice("/agent/file/".length));
    const b64 = await env.KV.get(key);
    if (!b64) return json({ ok: false, error: "not found" }, 404);
    return new Response(b64ToBuf(b64).buffer, {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  // shared database for the agent
  if (p === "/agent/db" && req.method === "GET") {
    return json({ ok: true, items: await DB.dbList(env) });
  }
  if (p.startsWith("/agent/db/")) {
    const key = decodeURIComponent(p.slice("/agent/db/".length));
    if (!key) return json({ ok: false, error: "missing key" }, 400);
    if (req.method === "GET") {
      const r = await DB.dbGet(env, key);
      return r ? json({ ok: true, key, ...r }) : json({ ok: false, error: "not found" }, 404);
    }
    if (req.method === "PUT") {
      const b = await rj(req);
      const rec = await DB.dbSet(env, key, String(b.value ?? ""), b.comment !== undefined ? String(b.comment) : undefined);
      return json({ ok: true, key, ...rec });
    }
    if (req.method === "DELETE") {
      await DB.dbDel(env, key);
      return json({ ok: true });
    }
  }

  return json({ ok: false, error: "unknown endpoint" }, 404);
}
