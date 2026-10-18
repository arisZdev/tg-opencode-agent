// ---------- task records + github dispatch + renewal + cron watchdog ----------
import { notify } from "./notify.js";
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

// one GitHub Actions run per task, via repository_dispatch
export async function dispatchTask(env, t) {
  return gh(env, `/repos/${env.GH_OWNER}/${env.GH_REPO}/dispatches`, "POST", {
    event_type: "agent-task",
    client_payload: {
      task_id: t.id, model: t.model, prompt: t.prompt,
      worker_url: env.WORKER_PUBLIC_URL,
      task_token: t.token,
    },
  });
}

function dispatchFailMsg(status) {
  if (status === 403) {
    return "⚠️ اجرا روی گیت‌هاب شروع نشد (HTTP 403): اکانت گیت‌هاب ساسپند است یا توکن دسترسی ندارد.\n" +
      "راه حل: درخواست رفع ساسپند در support.github.com، یا اکانت/ریپوی جدید.";
  }
  if (status === 401) return "⚠️ اجرا روی گیت‌هاب شروع نشد (HTTP 401): توکن گیت‌هاب نامعتبر است.";
  return null;
}

export async function createTask(env, { prompt, model, files, idle_min, hb_min }) {
  const id = "T-" + rid(4);
  const token = tok();
  const t = {
    id, chat: Number(env.ADMIN_CHAT_ID), prompt, model, token,
    status: "queued", created: Date.now(), updated: Date.now(),
    files: files || [], followups: [], kill: false, end: false,
    idle_min: idle_min || null, hb_min: hb_min || null, run_id: null, attempt: 1,
  };
  await putTask(env, t).catch((e) => {
    console.error("createTask put", String(e));
  });

  const d = await dispatchTask(env, t);

  if (!d.ok) {
    t.status = "failed"; t.error = "dispatch failed HTTP " + d.status;
    await putTask(env, t).catch((e) => console.error("createTask fail-put", String(e)));
    await notify(env, dispatchFailMsg(d.status) || `⚠️ ساخت تسک ${id} روی گیت‌هاب ناموفق بود (HTTP ${d.status}).`);
    return { t, ok: false };
  }
  // if the very first write failed (KV quota), the task record is missing —
  // the agent would get 401 forever. Say so honestly instead of pretending.
  const checkRec = await getTask(env, id);
  if (!checkRec) {
    await notify(env, `⚠️ تسک ${id} ساخته نشد: سهمیه روزانه KV پر است (ریست: ۰۰:۰۰ UTC). چند ساعت دیگر دوباره امتحان کن.`);
    return { t, ok: false };
  }

  const nfiles = (files || []).length;
  await notify(env,
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
    await notify(env, `🛑 تسک ${t.id} متوقف شد (کیل).`);
  } else {
    t.end = true;
    await putTask(env, t);
    await notify(env, `🏁 درخواست پایان برای ${t.id} ثبت شد؛ به‌محض توقف اجرای فعلی بسته می‌شه.`);
  }
  return true;
}

// re-queue a task onto a fresh runner (window renewal / crash revive).
// carry = { text, files } that survived an interrupted attempt and must be
// re-delivered to the new attempt as a followup.
export async function renewTask(env, t, carry = {}) {
  if (!["queued", "running"].includes(t.status)) return { ok: false, error: "task not active" };
  const att = Number(t.attempt || 1);
  if (att >= 3) return { ok: false, error: "attempt limit reached (3)" };
  t.status = "queued";
  t.attempt = att + 1;
  t.run_id = null;
  t.renewed_at = Date.now();
  t.updated = Date.now();
  const fups = t.followups || [];
  const cfiles = (Array.isArray(carry.files) ? carry.files : [])
    .filter((f) => f && f.key)
    .slice(0, 10)
    .map((f) => ({ key: String(f.key).slice(0, 80), name: String(f.name || "file").slice(0, 120) }));
  if ((carry.text && String(carry.text).trim()) || cfiles.length) {
    fups.push({ text: String(carry.text || "").slice(0, 8000), files: cfiles, at: Date.now(), note: "interrupted-window" });
  }
  t.followups = fups;
  try { await putTask(env, t); } catch (e) { console.error("renew put", String(e)); }

  const d = await dispatchTask(env, t);
  if (!d.ok) {
    t.status = "failed"; t.error = "renew dispatch failed HTTP " + d.status;
    try { await putTask(env, t); } catch {}
    await notify(env, dispatchFailMsg(d.status) || `⚠️ تمدید اجرای ${t.id} ناموفق بود (HTTP ${d.status}).`);
    return { ok: false, error: d.status };
  }
  await notify(env, `🔄 سقف زمانی رانر گیت‌هاب نزدیک بود یا اجرا قطع شده بود؛ تسک ${t.id} روی رانر تازه ادامه پیدا می‌کند (تلاش ${t.attempt}).`);
  return { ok: true, attempt: t.attempt };
}

// sync task status from github run (used by /tasks and cron).
// self-healing: a run that died from the ~6h window limit is auto-renewed.
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
      // failure / timeout: distinguish the ~6h runner-window kill from real errors
      const started = Date.parse(run.run_started_at || run.created_at || 0) || 0;
      const ended = Date.parse(run.updated_at || "") || Date.now();
      const elapsedMin = Math.max(0, Math.round((ended - started) / 60000));
      if (elapsedMin >= 320 && Number(t.attempt || 1) < 3) {
        await renewTask(env, t); // window exhaustion → auto-continue on a fresh runner
      } else {
        t.status = "failed"; t.error = "github conclusion: " + c; await putTask(env, t);
        await notify(env, `⚠️ تسک ${t.id} ناموفق تمام شد (${c}، ${elapsedMin} دقیقه اجرا).`);
      }
    }
  }
  return t.status;
}

// cron watchdog: revives stuck tasks and syncs run state
export async function cronCheck(env) {
  const tasks = await listTasks(env);
  for (const t of tasks) {
    try {
      if (!["queued", "running"].includes(t.status)) continue;
      if (!t.run_id) {
        const age = Date.now() - t.created;
        const sinceRenew = t.renewed_at ? Date.now() - t.renewed_at : Infinity;
        // never started? give the runner ~10 min to boot, then re-dispatch (up to 3 attempts)
        if (age > 10 * 60_000 && sinceRenew > 5 * 60_000) {
          if (Number(t.attempt || 1) < 3) {
            t.attempt = Number(t.attempt || 1) + 1;
            t.renewed_at = Date.now();
            try {
              await putTask(env, t);
            } catch (e) {
              console.error("revive put", String(e)); // KV quota — retry next cycle
              continue;
            }
            const d = await dispatchTask(env, t);
            if (d.ok) {
              await notify(env, `🔁 تسک ${t.id} روی گیت‌هاب شروع نشده بود؛ دوباره سپرده شد (تلاش ${t.attempt}).`);
            } else {
              t.status = "failed"; t.error = "dispatch failed HTTP " + d.status;
              await putTask(env, t);
              await notify(env, dispatchFailMsg(d.status) || `⚠️ تسک ${t.id} شروع نشد (dispatch HTTP ${d.status}).`);
            }
          } else {
            t.status = "failed"; t.error = "run never started (attempts exhausted)";
            await putTask(env, t);
            await notify(env, `⚠️ تسک ${t.id} پس از چند تلاش روی گیت‌هاب شروع نشد.`);
          }
        }
        continue;
      }
      await syncFromGithub(env, t);
    } catch (e) {
      console.error("cron task", t.id, String(e));
    }
  }
}
