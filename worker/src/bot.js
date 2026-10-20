// ---------- bot logic (telegram + bale): commands, task wizard, followups, /db ----------
import { sendMsg as tgSend, tg as tgApi, downloadTgFile } from "./tg.js";
import { sendMsg as baleSend, bale as baleApi, downloadFile as baleDownload, baleEnabled } from "./bale.js";
import { rid, bufToB64 } from "./util.js";
import { createTask, listTasks, getTask, putTask, stopTask, renewTask, startAgent, stopAgent, syncFromGithub, STATUS_EMO, STATUS_FA } from "./tasks.js";
import * as DB from "./db.js";
import { GEMINI_MODELS, ZEN_FALLBACK, zenLabel } from "./models.js";

const HELP =
  "🤖 ربات عامل اوپن‌کد آماده‌ست!\n\n" +
  "🤖 ایجنت (رانر گیت‌هاب):\n" +
  "  /on — روشن کردن ایجنت (یا دکمه در /tasks)\n" +
  "  /off — خاموش کردن ایجنت\n" +
  "  بعد از آخرین تسک، ۱۰ دقیقه تسک جدیدی نرسد، خودش خاموش می‌شود.\n\n" +
  "➕ تسک جدید: /new\n" +
  "  ۱) پرامپت کار رو بنویس\n" +
  "  ۲) فایل‌هات رو بفرست (اختیاری، تا ۱۵MB هر فایل)\n" +
  "  ۳) مدل رو انتخاب کن\n" +
  "  ۴) تأیید کن → ایجنت تسک رو برمی‌داره\n\n" +
  "🧠 مدل‌ها:\n" +
  "  • Gemini (رایگان، از سرور کار می‌کنه) — نیاز به کلید رایگان:\n" +
  "    /db set gemini_key <کلید از aistudio.google.com>\n" +
  "  • OpenRouter (مدل‌های :free) — نیاز به کلید رایگان:\n" +
  "    /db set openrouter_key <کلید از openrouter.ai>\n" +
  "  • Zen اوپن‌کد (با توکن خودت) — tier رایگانش ممکنه از سرور بلاک باشه\n\n" +
  "💬 وسط کار: هر متن/فایلی بفرستی، می‌پرسم به کدوم تسک بدم؛ عامل ادامه میده.\n" +
  "📦 خروجی‌های عامل خودکار به همین چت میان (همزمان روی بله و تلگرام).\n\n" +
  "🗄 دیتابیس کلید/مقدار (برای ذخیره API key و نکته‌ها):\n" +
  "  /db set <کلید> <مقدار>\n" +
  "  /db get <کلید>\n" +
  "  /db comment <کلید> <کامنت>\n" +
  "  /db list\n" +
  "  /db del <کلید>\n" +
  "  (عامل هم به این دیتابیس دسترسی خواندن/نوشتن داره)\n\n" +
  "📊 وضعیت تسک‌ها: /tasks\n" +
  "🛑 توقف فوری تسک: /kill T-xxxx\n" +
  "🏁 پایان تسک: /end T-xxxx\n" +
  "🔄 شروع دوباره تسک روی رانر تازه: /renew T-xxxx\n\n" +
  "⚠️ سقف هر اجرا حدود ۵.۵ ساعت است؛ ربات خودش قبل از سقف، تسک را روی رانر تازه ادامه می‌دهد (تا ۳ تلاش).";

// ---------- per-platform adapter ----------
function P(env, pf) {
  if (pf === "bale") {
    return {
      pf,
      admin: env.BALE_ADMIN_ID,
      send: (chat, txt, extra) => baleSend(env, chat, txt, extra),
      dl: (fileId) => baleDownload(env, fileId),
      ack: (cbId) => baleApi(env, "answerCallbackQuery", { callback_query_id: cbId }),
      label: "بله",
    };
  }
  return {
    pf: "tg",
    admin: env.ADMIN_CHAT_ID,
    send: (chat, txt, extra) => tgSend(env, chat, txt, extra),
    dl: (fileId) => downloadTgFile(env, fileId),
    ack: (cbId) => tgApi(env, "answerCallbackQuery", { callback_query_id: cbId }),
    label: "تلگرام",
  };
}

// ---------- wizard state helpers ----------
const getW = (env, chat) => env.KV.get(`w:${chat}`, "json");
const putW = (env, chat, w) => env.KV.put(`w:${chat}`, JSON.stringify(w));
const delW = (env, chat) => env.KV.delete(`w:${chat}`);

// ---------- models ----------
const PAGE = 8;

export async function getModels(env) {
  const out = [];
  out.push(...GEMINI_MODELS);

  try {
    const c = await env.KV.get("cache:or", "json");
    let ids;
    if (c && Date.now() - c.at < 6 * 3600_000 && c.ids?.length) ids = c.ids;
    else {
      const r = await fetch("https://openrouter.ai/api/v1/models");
      const j = await r.json();
      ids = (j.data || [])
        .filter((m) => (m.id || "").endsWith(":free"))
        .map((m) => m.id)
        .slice(0, 20);
      if (ids.length) await env.KV.put("cache:or", JSON.stringify({ at: Date.now(), ids }), { expirationTtl: 21600 });
    }
    for (const id of ids) {
      out.push({ id: "openrouter/" + id, label: id.replace(":free", "") + " •OR", provider: "openrouter" });
    }
  } catch (e) {
    console.error("openrouter models", String(e));
  }

  try {
    const c = await env.KV.get("cache:zen", "json");
    let ids;
    if (c && Date.now() - c.at < 6 * 3600_000 && c.ids?.length) ids = c.ids;
    else {
      const r = await fetch(`${env.ZEN_BASE}/models`, { headers: { authorization: `Bearer ${env.OC_API_KEY}` } });
      if (!r.ok) throw new Error("zen HTTP " + r.status);
      const j = await r.json();
      ids = (j.data || []).map((m) => m.id).filter((i) => i.endsWith("-free") || i === "big-pickle");
      if (ids.length) await env.KV.put("cache:zen", JSON.stringify({ at: Date.now(), ids }), { expirationTtl: 21600 });
    }
    for (const id of ids) out.push({ id: "opencode/" + id, label: zenLabel(id), provider: "opencode" });
  } catch (e) {
    console.error("zen models", String(e));
    for (const id of ZEN_FALLBACK) out.push({ id: "opencode/" + id, label: zenLabel(id), provider: "opencode" });
  }

  return out;
}

export function providerOf(model) {
  return String(model || "").split("/")[0];
}

export async function keyFor(env, model) {
  const p = providerOf(model);
  if (p === "opencode") return (env.OC_API_KEY || "") || null;
  if (p === "openrouter") {
    const dbk = await DB.dbGet(env, "openrouter_key");
    return (dbk?.value || env.OPENROUTER_API_KEY || "") || null;
  }
  if (p === "google") {
    const dbk = await DB.dbGet(env, "gemini_key");
    return (dbk?.value || env.GEMINI_API_KEY || "") || null;
  }
  return null;
}

function modelKeyboard(models, page) {
  const start = page * PAGE;
  const slice = models.slice(start, start + PAGE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map((m) => ({ text: m.label, callback_data: "m:" + m.id })));
  }
  const nav = [];
  if (page > 0) nav.push({ text: "◀️ قبلی", callback_data: `mp:${page - 1}` });
  if (start + PAGE < models.length) nav.push({ text: "بعدی ▶️", callback_data: `mp:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: `صفحه ${page + 1}/${Math.ceil(models.length / PAGE)} — کل: ${models.length}`, callback_data: "noop" }]);
  return { inline_keyboard: rows };
}

const FILES_KB = { inline_keyboard: [[
  { text: "✅ تمام شد — انتخاب مدل", callback_data: "files:done" },
  { text: "⏭ بدون فایل", callback_data: "files:skip" },
]] };

const CONFIRM_KB = { inline_keyboard: [[
  { text: "🚀 شروع کن", callback_data: "cfm:yes" },
  { text: "❌ لغو", callback_data: "cfm:no" },
]] };

// ---------- entry ----------
export async function handleUpdate(env, u, pf = "tg") {
  const A = P(env, pf);
  try {
    if (u.callback_query) return await onCb(env, u.callback_query, pf);
    const m = u.message;
    if (!m) return;
    const chat = m.chat?.id;
    if (!chat || String(chat) !== String(A.admin)) return;
    if (m.document || m.photo) return await onFile(env, chat, m, pf);
    const t = (m.text || "").trim();
    if (!t) return;
    if (t.startsWith("/")) return await onCmd(env, chat, t, pf);
    if (/^(تسک جدید|new task|new)$/i.test(t)) return await startWizard(env, chat, pf);
    return await onPlain(env, chat, t, pf);
  } catch (e) {
    console.error("handleUpdate", pf, String(e));
  }
}

// ---------- commands ----------
async function onCmd(env, chat, text, pf) {
  const A = P(env, pf);
  const parts = text.split(/\s+/);
  const cmd = (parts[0] || "").split("@")[0].toLowerCase();
  const rest = parts.slice(1);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/start": return A.send(chat, HELP);
    case "/help": return A.send(chat, HELP);
    case "/new": return startWizard(env, chat, pf);
    case "/cancel": await delW(env, chat); return A.send(chat, "❌ لغو شد.");
    case "/tasks": return cmdTasks(env, chat, pf);
    case "/models": {
      const ms = await getModels(env);
      return A.send(chat, "🧠 مدل‌های موجود:\n" + ms.map((m) => "• " + m.id).join("\n"));
    }
    case "/kill": return cmdStop(env, chat, arg.trim(), "kill", pf);
    case "/end": return cmdStop(env, chat, arg.trim(), "end", pf);
    case "/renew": return cmdRenew(env, chat, arg.trim(), pf);
    case "/on": return cmdAgent(env, chat, "on", pf);
    case "/off": return cmdAgent(env, chat, "off", pf);
    case "/db": return cmdDb(env, chat, rest, pf);
    case "/id": return A.send(chat, `پلتفرم: ${A.label} — شناسه چت شما: ` + chat);
    default: return A.send(chat, "دستور ناشناخته. راهنما: /start");
  }
}

async function cmdTasks(env, chat, pf) {
  const A = P(env, pf);
  const tasks = await listTasks(env);
  if (!tasks.length) return A.send(chat, "هنوز تسکی نساختی. با /new شروع کن.");
  const lines = [];
  const rows = [];
  for (const t of tasks.slice(0, 15)) {
    await syncFromGithub(env, t);
    const st = t.status;
    const mins = Math.round((Date.now() - (t.created || Date.now())) / 60000);
    const att = Number(t.attempt || 1);
    lines.push(`${STATUS_EMO[st] || "•"} ${t.id} — ${STATUS_FA[st] || st} — ${t.model} — ${mins} دقیقه${att > 1 ? ` — تلاش ${att}` : ""}`);
    if (["queued", "running"].includes(st)) {
      rows.push([
        { text: `🛑 کیل ${t.id}`, callback_data: `kil:${t.id}` },
        { text: `🏁 پایان ${t.id}`, callback_data: `end:${t.id}` },
        { text: `🔄 تمدید`, callback_data: `rnw:${t.id}` },
      ]);
    }
  }
  rows.push([
    { text: "🟢 روشن کردن ایجنت", callback_data: "on" },
    { text: "⏹ خاموش کردن ایجنت", callback_data: "off" },
  ]);
  rows.push([{ text: "➕ تسک جدید", callback_data: "new" }]);
  return A.send(chat, lines.join("\n"), { reply_markup: { inline_keyboard: rows } });
}

async function cmdStop(env, chat, id, mode, pf) {
  const A = P(env, pf);
  if (!id) return A.send(chat, "فرمت: /" + (mode === "kill" ? "kill" : "end") + " T-xxxx");
  const t = await getTask(env, id);
  if (!t) return A.send(chat, "تسکی با آیدی «" + id + "» پیدا نشد.");
  if (!["queued", "running"].includes(t.status)) return A.send(chat, "این تسک در حال اجرا نیست (" + (STATUS_FA[t.status] || t.status) + ").");
  await stopTask(env, t, mode);
}

async function cmdAgent(env, chat, mode, pf) {
  const A = P(env, pf);
  if (mode === "on") {
    const s = await startAgent(env);
    if (!s.ok) {
      const extra = s.status === 403 ? "\nاکانت گیت‌هاب ساسپند است یا توکن مشکل دارد." : "";
      return A.send(chat, `⚠️ روشن کردن ایجنت ناموفق بود (HTTP ${s.status}).${extra}`);
    }
    return A.send(chat, s.already
      ? "🟢 ایجنت از قبل روشن است و منتظر تسک است."
      : "🟢 درخواست روشن‌شدن ایجنت ثبت شد؛ ~۱ دقیقه دیگر آماده‌ست. تسک‌ها را با /new بده.");
  }
  await stopAgent(env);
  return A.send(chat, "⏹ درخواست خاموشی ایجنت ثبت شد؛ تا ~۱ دقیقه دیگر بسته می‌شود.\n(تسک‌های صف‌شده می‌مانند و بعد از /on اجرا می‌شوند)");
}

async function cmdRenew(env, chat, id, pf) {
  const A = P(env, pf);
  if (!id) return A.send(chat, "فرمت: /renew T-xxxx");
  const t = await getTask(env, id);
  if (!t) return A.send(chat, "تسکی با آیدی «" + id + "» پیدا نشد.");
  if (!["queued", "running"].includes(t.status)) return A.send(chat, "این تسک در حال اجرا نیست (" + (STATUS_FA[t.status] || t.status) + ").");
  const r = await renewTask(env, t, {});
  if (!r.ok) return A.send(chat, "⚠️ تمدید ناموفق: " + (r.error || "خطای نامشخص"));
  return A.send(chat, `🔄 تسک ${t.id} برای اجرای دوباره روی رانر تازه سپرده شد (تلاش ${r.attempt}).`);
}

async function cmdDb(env, chat, args, pf) {
  const A = P(env, pf);
  const sub = (args[0] || "list").toLowerCase();
  const key = args[1];
  const val = args.slice(2).join(" ");
  if (sub === "set") {
    if (!key || !val) return A.send(chat, "فرمت: /db set <کلید> <مقدار>");
    await DB.dbSet(env, key, val, undefined);
    return A.send(chat, `💾 ذخیره شد: ${key}`);
  }
  if (sub === "get") {
    if (!key) return A.send(chat, "فرمت: /db get <کلید>");
    const r = await DB.dbGet(env, key);
    if (!r) return A.send(chat, "کلید پیدا نشد.");
    return A.send(chat, `🔑 ${key}\n\n${r.value}\n\n💬 ${r.comment || "—"}`);
  }
  if (sub === "del") {
    if (!key) return A.send(chat, "فرمت: /db del <کلید>");
    await DB.dbDel(env, key);
    return A.send(chat, `🗑 حذف شد: ${key}`);
  }
  if (sub === "comment") {
    if (!key || !val) return A.send(chat, "فرمت: /db comment <کلید> <کامنت>");
    const r = await DB.dbGet(env, key);
    if (!r) return A.send(chat, "کلید پیدا نشد.");
    await DB.dbSet(env, key, r.value, val);
    return A.send(chat, "💬 کامنت ذخیره شد.");
  }
  if (sub === "list") {
    const items = await DB.dbList(env);
    if (!items.length) return A.send(chat, "دیتابیس خالیه. با /db set <کلید> <مقدار> شروع کن.");
    return A.send(chat, "🗄 دیتابیس:\n" + items.map((i) => {
      const v = String(i.value ?? "");
      return `• ${i.key} = ${v.slice(0, 40)}${v.length > 40 ? "…" : ""}${i.comment ? `   💬 ${String(i.comment).slice(0, 40)}` : ""}`;
    }).join("\n"));
  }
  return A.send(chat, "زیرفرمت‌ها: set / get / comment / list / del");
}

// ---------- wizard ----------
async function startWizard(env, chat, pf) {
  const A = P(env, pf);
  await putW(env, chat, { step: "await_prompt", files: [], pf });
  return A.send(chat,
    "📝 پرامپت تسک رو بنویس — کامل و دقیق، مثل حرف زدن با یه برنامه‌نویس.\n(لغو: /cancel)");
}

async function renderModels(env, chat, w, page, pf) {
  const A = P(env, pf);
  const models = await getModels(env);
  const p = Math.max(0, Math.min(page, Math.ceil(models.length / PAGE) - 1));
  // NOTE: no putW here — a slow model-list fetch used to overwrite a model the
  // user had already picked while this render was in flight (classic race).
  // w.page is never read anywhere; the callback carries the page explicitly.
  return A.send(chat,
    `🧠 مدل رو انتخاب کن (پیشنهادی: Gemini Flash — از سرور کار می‌کنه):
فایل‌های ذخیره‌شده: ${(w.files || []).length}`,
    { reply_markup: modelKeyboard(models, p) });
}

async function finishFiles(env, chat, pf) {
  const A = P(env, pf);
  const w = await getW(env, chat);
  if (!w || w.step !== "await_files") return;
  w.step = "await_model";
  await putW(env, chat, w);
  return renderModels(env, chat, w, 0, pf);
}

async function confirmYes(env, chat, pf) {
  const A = P(env, pf);
  const w = await getW(env, chat);
  if (!w || !w.prompt || !w.model) return A.send(chat, "اطلاعات تسک کامل نیست؛ دوباره /new بزن.");
  const key = await keyFor(env, w.model);
  if (!key) {
    const p = providerOf(w.model);
    const how = p === "google"
      ? "از aistudio.google.com یه کلید رایگان بگیر بعد بزن:\n/db set gemini_key <کلید>"
      : "از openrouter.ai/keys یه کلید رایگان بگیر بعد بزن:\n/db set openrouter_key <کلید>";
    return A.send(chat, `⚠️ برای مدل «${w.model}» کلید provider «${p}» پیدا نشد.\n\n🔑 ${how}\nبعدش دوباره تأیید کن (🚀 شروع کن).`, { reply_markup: CONFIRM_KB });
  }
  await delW(env, chat);
  await createTask(env, { prompt: w.prompt, model: w.model, files: w.files || [] });
}

async function onPlain(env, chat, text, pf) {
  const A = P(env, pf);
  const w = await getW(env, chat);
  if (w) {
    switch (w.step) {
      case "await_prompt": {
        if (text.length < 5) return A.send(chat, "پرامپت خیلی کوتاهه؛ کامل‌تر بنویس. (لغو: /cancel)");
        w.prompt = text; w.step = "await_files"; w.files = w.files || [];
        await putW(env, chat, w);
        return A.send(chat,
          "✅ پرامپت ثبت شد.\nحالا فایل‌هات رو بفرست (تا ۱۵MB هر فایل). تمام شد؟ دکمه زیر یا /done. فایل نداری؟ «بدون فایل» یا /skip",
          { reply_markup: FILES_KB });
      }
      case "await_files":
        if (/^(\/done|done|تمام|تمام شد|ادامه)$/i.test(text)) return finishFiles(env, chat, pf);
        if (/^(\/skip|skip|نه|رد شو|بدون فایل)$/i.test(text)) return finishFiles(env, chat, pf);
        return A.send(chat, "فایل بفرست یا از دکمه‌ها استفاده کن (تمام شد / بدون فایل).", { reply_markup: FILES_KB });
      case "await_model":
        return A.send(chat, "یکی از مدل‌ها رو از دکمه‌های پیام قبل انتخاب کن.");
      case "await_confirm":
        if (/^(\/yes|بله|تایید|تأیید|ok|yes)$/i.test(text)) return confirmYes(env, chat, pf);
        if (/^(\/no|نه|لغو|no)$/i.test(text)) { await delW(env, chat); return A.send(chat, "لغو شد."); }
        return A.send(chat, "شروع کنم؟ (بله / نه)", { reply_markup: CONFIRM_KB });
      case "await_target":
        return A.send(chat, "اول مقصد رو از دکمه‌های پیام قبل انتخاب کن یا /cancel بزن.");
    }
  }
  return offerTarget(env, chat, { text }, pf);
}

async function onFile(env, chat, m, pf) {
  const A = P(env, pf);
  let fileId, name, size;
  if (m.document) {
    fileId = m.document.file_id;
    name = m.document.file_name || ("file-" + rid(4));
    size = m.document.file_size || 0;
  } else if (m.photo && m.photo.length) {
    const p = m.photo[m.photo.length - 1];
    fileId = p.file_id;
    name = `photo-${p.file_unique_id || rid(4)}.jpg`;
    size = p.file_size || 0;
  } else return;
  const w = await getW(env, chat);

  // caption commands inside wizard
  if (w && w.step === "await_files" && m.caption && /^(\/done|done|تمام شد)$/i.test(m.caption.trim())) {
    return finishFiles(env, chat, pf);
  }

  if (size > 15 * 1024 * 1024) {
    return A.send(chat, "⚠️ حجم فایل بیشتر از ۱۵ مگابایت است (محدودیت دانلود ربات).");
  }

  if (w && w.step === "await_files") {
    try {
      const bytes = await A.dl(fileId);
      const key = "f:" + crypto.randomUUID();
      await env.KV.put(key, bufToB64(bytes), { expirationTtl: 48 * 3600 });
      w.files = w.files || [];
      w.files.push({ key, name, size: bytes.length });
      await putW(env, chat, w);
      return A.send(chat, `📎 «${name}» ذخیره شد (مجموع: ${w.files.length} فایل). فایل بعدی یا «تمام شد»؟`, { reply_markup: FILES_KB });
    } catch (e) {
      console.error("onFile dl", pf, String(e));
      return A.send(chat, "⚠️ دانلود فایل ناموفق بود.");
    }
  }

  if (w && w.step !== "await_target") {
    return A.send(chat, "الان توی ویزارد تسک جدیدی؛ اول مرحله‌ها رو کامل کن یا /cancel بزن.");
  }
  if (w && w.step === "await_target") {
    return A.send(chat, "اول مقصد رو انتخاب کن (دکمه‌های پیام قبل) یا /cancel.");
  }

  // mid-task followup: store file now, then pick target task
  try {
    const bytes = await A.dl(fileId);
    const key = "f:" + crypto.randomUUID();
    await env.KV.put(key, bufToB64(bytes), { expirationTtl: 48 * 3600 });
    return offerTarget(env, chat, { file: { key, name } }, pf);
  } catch (e) {
    console.error("onFile dl2", pf, String(e));
    return A.send(chat, "⚠️ دانلود فایل ناموفق بود.");
  }
}

// ---------- followup routing ----------
async function activeTasks(env) {
  const all = await listTasks(env);
  return all.filter((t) => ["queued", "running"].includes(t.status));
}

async function offerTarget(env, chat, pending, pf) {
  const A = P(env, pf);
  const active = await activeTasks(env);
  if (!active.length) {
    return A.send(chat, "تسک فعالی وجود نداره. با /new یه تسک جدید بساز 👇",
      { reply_markup: { inline_keyboard: [[{ text: "➕ تسک جدید", callback_data: "new" }]] } });
  }
  if (active.length === 1) return attachFollowup(env, chat, active[0], pending, pf);
  const w = (await getW(env, chat)) || { step: "await_target", pf };
  w.step = "await_target";
  w.pending = pending;
  await putW(env, chat, w);
  return A.send(chat, "به کدوم تسک بفرستم؟", {
    reply_markup: { inline_keyboard: active.map((t) => [{ text: `${STATUS_EMO[t.status]} ${t.id} (${t.model})`, callback_data: `tgt:${t.id}` }]) },
  });
}

async function attachFollowup(env, chat, t, pending, pf) {
  const A = P(env, pf);
  t.followups = t.followups || [];
  if (t.followups.length > 50) return A.send(chat, "صف پیام‌های این تسک پر شده.");
  t.followups.push({ text: pending.text || "", files: pending.file ? [pending.file] : [], at: Date.now() });
  try {
    await putTask(env, t);
  } catch (e) {
    console.error("followup put", String(e));
    return A.send(chat, "⚠️ ذخیره پیام ناموفق بود (سهمیه روزانه KV پر شده). چند دقیقه دیگر دوباره بفرست.");
  }
  const desc = (pending.text ? "متن" + (pending.file ? "+فایل" : "") : "فایل");
  return A.send(chat, `📩 ${desc} به صف تسک ${t.id} اضافه شد — تا ~۲۰ ثانیه دیگه تحویل عامل میشه.`);
}

// ---------- callbacks ----------
async function onCb(env, cb, pf) {
  const A = P(env, pf);
  const chat = cb.message?.chat?.id;
  const data = cb.data || "";
  const ack = () => A.ack(cb.id);
  try {
    if (!chat || String(chat) !== String(A.admin)) return await ack();

    if (data.startsWith("m:")) {
      const w = await getW(env, chat);
      if (!w || w.step !== "await_model") return await ack();
      w.model = data.slice(2);
      w.step = "await_confirm";
      await putW(env, chat, w);
      const pf2 = String(w.prompt || "");
      await A.send(chat,
        `🚀 آماده اجرا:\n\n📝 پرامپت: ${pf2.slice(0, 400)}${pf2.length > 400 ? "…" : ""}\n🧠 مدل: ${w.model}\n📁 فایل‌ها: ${(w.files || []).length}\n\nشروع کنم؟`,
        { reply_markup: CONFIRM_KB });
      return await ack();
    }
    if (data.startsWith("mp:")) {
      const w = await getW(env, chat);
      if (!w || w.step !== "await_model") return await ack();
      await renderModels(env, chat, w, Number(data.slice(3)) || 0, pf);
      return await ack();
    }
    if (data === "noop") return await ack();
    if (data === "files:done" || data === "files:skip") { await finishFiles(env, chat, pf); return await ack(); }
    if (data === "cfm:yes") return await confirmYes(env, chat, pf), await ack();
    if (data === "cfm:no") { await delW(env, chat); await A.send(chat, "لغو شد."); return await ack(); }
    if (data === "new") return await startWizard(env, chat, pf), await ack();
    if (data.startsWith("tgt:")) {
      const w = await getW(env, chat);
      const t = await getTask(env, data.slice(4));
      if (w?.step === "await_target" && t && ["queued", "running"].includes(t.status)) {
        await delW(env, chat);
        await attachFollowup(env, chat, t, w.pending || {}, pf);
        return await ack();
      }
      return await ack();
    }
    if (data.startsWith("kil:")) { const t = await getTask(env, data.slice(4)); if (t) await stopTask(env, t, "kill"); return await ack(); }
    if (data.startsWith("end:")) { const t = await getTask(env, data.slice(4)); if (t) await stopTask(env, t, "end"); return await ack(); }
    if (data.startsWith("rnw:")) { const t = await getTask(env, data.slice(4)); if (t) await renewTask(env, t, {}); return await ack(); }
    if (data === "on") { await cmdAgent(env, chat, "on", pf); return await ack(); }
    if (data === "off") { await cmdAgent(env, chat, "off", pf); return await ack(); }
    return await ack();
  } catch (e) {
    console.error("onCb", data, String(e));
    try { await ack(); } catch {}
  }
}
