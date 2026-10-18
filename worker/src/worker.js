// ---------- worker entry: router ----------
import { json, text, rj, b64ToBuf } from "./util.js";
import { handleUpdate } from "./bot.js";
import { cronCheck, getTask, putTask, renewTask } from "./tasks.js";
import { notify, notifyDoc } from "./notify.js";
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
        ctx.waitUntil(dedupAndHandle(env, u, "tg", "g:last_upd"));
        ctx.waitUntil(maybeWatchdog(env));
        return text("ok");
      }

      // bale.ai webhook — secret is embedded in the registered URL path
      if (p.startsWith("/bale/webhook") && req.method === "POST") {
        const secret = p.slice("/bale/webhook/".length);
        if (!env.BALE_WEBHOOK_SECRET || secret !== env.BALE_WEBHOOK_SECRET) {
          return text("forbidden", 403);
        }
        const u = await req.json();
        ctx.waitUntil(dedupAndHandle(env, u, "bale", "g:last_upd_bale"));
        ctx.waitUntil(maybeWatchdog(env));
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

async function dedupAndHandle(env, u, pf, key) {
  let last = 0;
  try { last = Number((await env.KV.get(key)) || 0); } catch (e) { console.error("dedup get", String(e)); }
  if (u.update_id && u.update_id <= last) return;
  try {
    await handleUpdate(env, u, pf);
  } finally {
    // record best-effort AFTER handling — a KV failure must never silence the bot
    // (also never store Date.now() here: update_id-scale values only)
    if (u.update_id) {
      try { await env.KV.put(key, String(u.update_id)); }
      catch (e) { console.error("dedup put", String(e)); }
    }
  }
}

// fallback watchdog (replaces cron trigger): throttled to once per 15 minutes,
// runs whenever any bot traffic comes in. Timestamp write is best-effort and
// only happens AFTER the check — KV write failures must not block handling.
async function maybeWatchdog(env) {
  try {
    const last = Number((await env.KV.get("g:last_watchdog")) || 0);
    if (Date.now() - last < 15 * 60_000) return;
    await cronCheck(env);
    try { await env.KV.put("g:last_watchdog", String(Date.now())); } catch (e) {}
  } catch (e) {
    console.error("watchdog", String(e));
  }
}

async function authTask(env, req, url) {
  const token = ((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")).trim();
  const id = req.headers.get("x-task-id") || url.searchParams.get("task") || "";
  if (!token) return null;
  let t = id ? await getTask(env, id) : null;
  if (!t) {
    // fallback: authenticate by token alone. Covers agents that omit the
    // X-Task-Id header (older AGENTS.md curl examples did) — the token is
    // unique per task and is the actual secret; the id is not secret.
    const l = await env.KV.list({ prefix: "t:", limit: 200 });
    for (const k of l.keys) {
      const c = await env.KV.get(k.name, "json");
      if (c && c.token === token) { t = c; break; }
    }
  }
  if (!t || t.token !== token) return null;
  return t;
}

async function agentRoute(env, req, url, ctx) {
  const p = url.pathname;

  if (p === "/agent/config" && req.method === "GET") {
    const t = await authTask(env, req, url);
    if (!t) return json({ ok: false, error: "unauthorized" }, 401);
    const orDb = await DB.dbGet(env, "openrouter_key");
    const gemDb = await DB.dbGet(env, "gemini_key");
    return json({
      ok: true,
      task_id: t.id,
      opencode_key: env.OC_API_KEY,
      keys: {
        opencode: env.OC_API_KEY || "",
        openrouter: orDb?.value || env.OPENROUTER_API_KEY || "",
        gemini: gemDb?.value || env.GEMINI_API_KEY || "",
      },
      poll_s: 15,
      heartbeat_min: Number(t.hb_min || env.HB_MIN || 15),
      idle_min: Number(t.idle_min || env.IDLE_MIN || 60),
      renew_min: Number(env.RENEW_MIN || 330),
      worker_url: env.WORKER_PUBLIC_URL,
    });
  }

  const t = await authTask(env, req, url);
  if (!t) return json({ ok: false, error: "unauthorized" }, 401);

  if (p === "/agent/poll" && req.method === "GET") {
    const fups = t.followups || [];
    const kill = !!t.kill, end = !!t.end;
    // write ONLY when something actually changed — idle polls (every 15s per
    // running task) must not burn the KV daily write quota (1000/day, free plan)
    if (fups.length || kill || end) {
      t.followups = []; t.kill = false; t.end = false;
      try { await putTask(env, t); } catch (e) { console.error("poll put", String(e)); }
    }
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
    try { await putTask(env, t); } catch (e) { console.error("register put", String(e)); }
    ctx.waitUntil(notify(env, `▶️ تسک ${t.id} روی GitHub Actions شروع شد${Number(t.attempt || 1) > 1 ? ` (تلاش ${t.attempt})` : ""}.`));
    return json({ ok: true });
  }

  // runner-window renewal: agent calls this shortly before the ~6h kill
  if (p === "/agent/renew" && req.method === "POST") {
    const b = await rj(req);
    const r = await renewTask(env, t, { text: b.carry_text || "", files: b.carry_files || [] });
    return json({ ok: r.ok, attempt: r.attempt, error: r.error }, r.ok ? 200 : 400);
  }

  if (p === "/agent/message" && req.method === "POST") {
    const b = await rj(req);
    const txt = String(b.text || "").slice(0, 60000);
    ctx.waitUntil(notify(env, `🤖 [${t.id}]\n${txt || "(پاسخ متنی خالی بود)"}`));
    return json({ ok: true });
  }

  if (p === "/agent/status" && req.method === "POST") {
    const b = await rj(req);
    ctx.waitUntil(notify(env, `⏳ [${t.id}] ${String(b.text || "هنوز در حال اجراست...")}`));
    return json({ ok: true });
  }

  if (p === "/agent/done" && req.method === "POST") {
    const b = await rj(req);
    t.status = "done"; t.finished = Date.now();
    try { await putTask(env, t); } catch (e) { console.error("done put", String(e)); }
    ctx.waitUntil(notify(env, `✅ تسک ${t.id} تمام شد.${b.text ? "\n" + String(b.text).slice(0, 500) : ""}`));
    return json({ ok: true });
  }

  if (p === "/agent/fail" && req.method === "POST") {
    const b = await rj(req);
    t.status = "failed"; t.error = String(b.text || "agent error").slice(0, 500); t.finished = Date.now();
    try { await putTask(env, t); } catch (e) { console.error("fail put", String(e)); }
    ctx.waitUntil(notify(env, `⚠️ تسک ${t.id} خطا داد:\n${t.error}`));
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
    const r = await notifyDoc(env, bytes, name, `📎 [${t.id}] ${name}${cap ? "\n" + cap : ""}`);
    const okAny = !!(r.tg?.ok || r.bale?.ok);
    // delivery audit trail (also lets external tools verify uploads)
    try {
      await env.KV.put(`ul:${Date.now()}`, JSON.stringify({
        task: t.id, name, size: f.size,
        ok: okAny, ok_tg: !!r.tg?.ok, ok_bale: !!r.bale?.ok,
        error: okAny ? undefined : (r.tg?.description || r.bale?.description), at: Date.now(),
      }), { expirationTtl: 7 * 24 * 3600 });
    } catch (e) { console.error("ul log", String(e)); }
    return json({ ok: okAny, error: okAny ? undefined : (r.tg?.description || r.bale?.description || "delivery failed") });
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
