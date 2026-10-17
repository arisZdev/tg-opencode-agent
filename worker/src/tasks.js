// ---------- task records + github dispatch + cron watchdog ----------
import { sendMsg } from "./tg.js";
import { gh } from "./gh.js";
import { rid, tok } from "./util.js";

export const STATUS_EMO = { queued: "⏳", running: "🟢", done: "✅", killed: "🛑", failed: "⚠️" };
export const STATUS_FA = { queued: "در صف", running: "در حال اجرا", done: "تمام شده", killed: "متوقف شده", failed: "خطا" };

export const getTask = (env, id) => env.KV.get(`t:${id}`, "json");
export const putTask = (env, t) => env.KV.put(`t:${t.id}`, JSON.stringify(t));

export async function listTasks(env) {
  const l = await env.KV.list({ prefix: "t:", limit: 200 });
  const out = [];
  for (const k of l.keys) {
    const t = await env.KV.get(k.name, "json");
    if (t) out.push(t);
  }
  out.sort((a, b) => (b.created || 0) - (a.created || 0));
  return out;
}

export async function createTask(env, { prompt, model, files, idle_min, hb_min }) {
  const id = "T-" + rid(4);
  const token = tok();
  const t = {
    id, chat: Number(env.ADMIN_CHAT_ID), prompt, model, token,
    status: "queued", created: Date.now(), updated: Date.now(),
    files: files || [], followups: [], kill: false, end: false,
    idle_min: idle_min || null, hb_min: hb_min || null, run_id: null,
  };
  await putTask(env, t);

  const d = await gh(env, `/repos/${env.GH_OWNER}/${env.GH_REPO}/dispatches`, "POST", {
    event_type: "agent-task",
    client_payload: {
      task_id: id, model, prompt,
      worker_url: env.WORKER_PUBLIC_URL,
      task_token: token,
    },
  });

  if (!d.ok) {
    t.status = "failed"; t.error = "dispatch failed HTTP " + d.status;
    await putTask(env, t);
    await sendMsg(env, t.chat, `⚠️ ساخت تسک ${id} روی گیت‌هاب ناموفق بود (HTTP ${d.status}).`);
    return { t, ok: false };
  }

  const nfiles = (files || []).length;
  await sendMsg(env, t.chat,
    `🚀 تسک ${id} ساخته شد و به گیت‌هاب اکشنز سپرده شد.\n` +
    `🧠 مدل: ${model}\n` +
    `📝 پرامپت: ${String(prompt).slice(0, 300)}${String(prompt).length > 300 ? "…" : ""}\n` +
    `📁 فایل‌ها: ${nfiles}\n\n` +
    `📊 وضعیت: /tasks\n💬 وسط کار هر متن/فایلی بفرستی ادامه میدم.`);
  return { t, ok: true };
}

// cancel or gracefully end a task
export async function stopTask(env, t, mode) {
  if (!["queued", "running"].includes(t.status)) return false;
  if (mode === "kill") {
    t.kill = true;
    t.status = "killed";
    if (t.run_id) {
      await gh(env, `/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/runs/${t.run_id}/cancel`, "POST");
    }
    await putTask(env, t);
    await sendMsg(env, t.chat, `🛑 تسک ${t.id} متوقف شد (کیل).`);
  } else {
    t.end = true;
    await putTask(env, t);
    await sendMsg(env, t.chat, `🏁 درخواست پایان برای ${t.id} ثبت شد؛ به‌محض توقف اجرای فعلی بسته می‌شه.`);
  }
  return true;
}

// sync task status from github run (used by /tasks and cron)
export async function syncFromGithub(env, t) {
  if (!t.run_id || !["queued", "running"].includes(t.status)) return t.status;
  const r = await gh(env, `/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/runs/${t.run_id}`);
  const run = r.j;
  if (!r.ok || !run) return t.status;
  if (run.status === "in_progress" && t.status === "queued") {
    t.status = "running"; t.updated = Date.now(); await putTask(env, t);
  } else if (run.status === "completed") {
    const c = run.conclusion;
    if (c === "success") {
      if (t.status === "running") { t.status = "done"; t.finished = Date.now(); await putTask(env, t); }
    } else if (c === "cancelled") {
      if (t.status !== "killed") { t.status = "killed"; await putTask(env, t); }
    } else {
      t.status = "failed"; t.error = "github conclusion: " + c; await putTask(env, t);
      await sendMsg(env, t.chat, `⚠️ تسک ${t.id} ناموفق تمام شد (${c}).`);
    }
  }
  return t.status;
}

// cron watchdog: runs every 5 minutes
export async function cronCheck(env) {
  const tasks = await listTasks(env);
  for (const t of tasks) {
    try {
      if (!["queued", "running"].includes(t.status)) continue;
      if (!t.run_id) {
        if (Date.now() - t.created > 15 * 60_000) {
          t.status = "failed"; t.error = "run never started";
          await putTask(env, t);
          await sendMsg(env, t.chat, `⚠️ تسک ${t.id} روی گیت‌هاب شروع نشد (dispatch بی‌پاسخ ماند).`);
        }
        continue;
      }
      await syncFromGithub(env, t);
    } catch (e) {
      console.error("cron task", t.id, String(e));
    }
  }
}
