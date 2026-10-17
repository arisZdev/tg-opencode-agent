// ---------- telegram bot logic: commands, task wizard, followups, /db ----------
import { sendMsg, tg, downloadTgFile } from "./tg.js";
import { rid, bufToB64 } from "./util.js";
import { createTask, listTasks, getTask, putTask, stopTask, syncFromGithub, STATUS_EMO, STATUS_FA } from "./tasks.js";
import * as DB from "./db.js";
import { FREE_MODELS_FALLBACK } from "./models.js";

const HELP =
  "🤖 ربات عامل اوپن‌کد آماده‌ست!\n\n" +
  "➕ تسک جدید: /new\n" +
  "  ۱) پرامپت کار رو بنویس\n" +
  "  ۲) فایل‌هات رو بفرست (اختیاری، تا ۱۵MB هر فایل)\n" +
  "  ۳) مدل رایگان رو انتخاب کن\n" +
  "  ۴) تأیید کن → اجرا روی گیت‌هاب اکشنز شروع میشه\n\n" +
  "💬 وسط کار: هر متن/فایلی بفرستی، می‌پرسم به کدوم تسک بدم؛ عامل ادامه میده.\n" +
  "📦 خروجی‌های عامل خودکار به همین چت میان.\n\n" +
  "🗄 دیتابیس کلید/مقدار (برای ذخیره API key و نکته‌ها):\n" +
  "  /db set <کلید> <مقدار>\n" +
  "  /db get <کلید>\n" +
  "  /db comment <کلید> <کامنت>\n" +
  "  /db list\n" +
  "  /db del <کلید>\n" +
  "  (عامل هم به این دیتابیس دسترسی خواندن/نوشتن داره)\n\n" +
  "📊 وضعیت تسک‌ها: /tasks\n" +
  "🧠 مدل‌های رایگان: /models\n" +
  "🛑 توقف فوری تسک: /kill T-xxxx\n" +
  "🏁 پایان تسک: /end T-xxxx\n\n" +
  "⚠️ سقف هر اجرا حدود ۵ ساعت و ۵۵ دقیقه است (محدودیت خود گیت‌هاب).";

// ---------- wizard state helpers ----------
const getW = (env, chat) => env.KV.get(`w:${chat}`, "json");
const putW = (env, chat, w) => env.KV.put(`w:${chat}`, JSON.stringify(w));
const delW = (env, chat) => env.KV.delete(`w:${chat}`);

// ---------- models ----------
export async function getModels(env) {
  try {
    const c = await env.KV.get("cache:models", "json");
    if (c && Date.now() - c.at < 6 * 3600_000 && c.list?.length) return c.list;
    const r = await fetch(`${env.ZEN_BASE}/models`, {
      headers: { authorization: `Bearer ${env.OC_API_KEY}` },
    });
    if (!r.ok) throw new Error("zen models HTTP " + r.status);
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id)
      .filter((i) => i.endsWith("-free") || i === "big-pickle");
    const known = Object.fromEntries(FREE_MODELS_FALLBACK.map((m) => [m.id, m.label]));
    const list = ids.map((i) => ({ id: i, label: known[i] || i }));
    // make sure deepseek stays first if present
    list.sort((a, b) => (a.id.startsWith("deepseek") ? -1 : b.id.startsWith("deepseek") ? 1 : 0));
    const final = list.length ? list : FREE_MODELS_FALLBACK;
    await env.KV.put("cache:models", JSON.stringify({ at: Date.now(), list: final }), { expirationTtl: 21600 });
    return final;
  } catch (e) {
    console.error("getModels", String(e));
    return FREE_MODELS_FALLBACK;
  }
}

function modelKeyboard(models) {
  const rows = [];
  for (let i = 0; i < models.length; i += 2) {
    rows.push(models.slice(i, i + 2).map((m) => ({ text: m.label, callback_data: "m:" + m.id })));
  }
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
export async function handleUpdate(env, u) {
  try {
    if (u.callback_query) return await onCb(env, u.callback_query);
    const m = u.message;
    if (!m) return;
    const chat = m.chat?.id;
    if (!chat || String(chat) !== String(env.ADMIN_CHAT_ID)) return;
    if (m.document || m.photo) return await onFile(env, chat, m);
    const t = (m.text || "").trim();
    if (!t) return;
    if (t.startsWith("/")) return await onCmd(env, chat, t);
    if (/^(تسک جدید|new task|new)$/i.test(t)) return await startWizard(env, chat);
    return await onPlain(env, chat, t);
  } catch (e) {
    console.error("handleUpdate", String(e));
  }
}

// ---------- commands ----------
async function onCmd(env, chat, text) {
  const parts = text.split(/\s+/);
  const cmd = (parts[0] || "").split("@")[0].toLowerCase();
  const rest = parts.slice(1);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/start": return sendMsg(env, chat, HELP);
    case "/help": return sendMsg(env, chat, HELP);
    case "/new": return startWizard(env, chat);
    case "/cancel": await delW(env, chat); return sendMsg(env, chat, "❌ لغو شد.");
    case "/tasks": return cmdTasks(env, chat);
    case "/models": {
      const ms = await getModels(env);
      return sendMsg(env, chat, "🧠 مدل‌های رایگان:\n" + ms.map((m) => "• " + m.id).join("\n"));
    }
    case "/kill": return cmdStop(env, chat, arg.trim(), "kill");
    case "/end": return cmdStop(env, chat, arg.trim(), "end");
    case "/db": return cmdDb(env, chat, rest);
    case "/id": return sendMsg(env, chat, "شناسه چت شما: " + chat);
    default: return sendMsg(env, chat, "دستور ناشناخته. راهنما: /start");
  }
}

async function cmdTasks(env, chat) {
  const tasks = await listTasks(env);
  if (!tasks.length) return sendMsg(env, chat, "هنوز تسکی نساختی. با /new شروع کن.");
  const lines = [];
  const rows = [];
  for (const t of tasks.slice(0, 15)) {
    await syncFromGithub(env, t);
    const st = t.status;
    const mins = Math.round((Date.now() - (t.created || Date.now())) / 60000);
    lines.push(`${STATUS_EMO[st] || "•"} ${t.id} — ${STATUS_FA[st] || st} — ${t.model} — ${mins} دقیقه`);
    if (["queued", "running"].includes(st)) {
      rows.push([
        { text: `🛑 کیل ${t.id}`, callback_data: `kil:${t.id}` },
        { text: `🏁 پایان ${t.id}`, callback_data: `end:${t.id}` },
      ]);
    }
  }
  rows.push([{ text: "➕ تسک جدید", callback_data: "new" }]);
  return sendMsg(env, chat, lines.join("\n"), { reply_markup: { inline_keyboard: rows } });
}

async function cmdStop(env, chat, id, mode) {
  if (!id) return sendMsg(env, chat, "فرمت: /" + (mode === "kill" ? "kill" : "end") + " T-xxxx");
  const t = await getTask(env, id);
  if (!t) return sendMsg(env, chat, "تسکی با آیدی «" + id + "» پیدا نشد.");
  if (!["queued", "running"].includes(t.status)) return sendMsg(env, chat, "این تسک در حال اجرا نیست (" + (STATUS_FA[t.status] || t.status) + ").");
  await stopTask(env, t, mode);
}

async function cmdDb(env, chat, args) {
  const sub = (args[0] || "list").toLowerCase();
  const key = args[1];
  const val = args.slice(2).join(" ");
  if (sub === "set") {
    if (!key || !val) return sendMsg(env, chat, "فرمت: /db set <کلید> <مقدار>");
    await DB.dbSet(env, key, val, undefined);
    return sendMsg(env, chat, `💾 ذخیره شد: ${key}`);
  }
  if (sub === "get") {
    if (!key) return sendMsg(env, chat, "فرمت: /db get <کلید>");
    const r = await DB.dbGet(env, key);
    if (!r) return sendMsg(env, chat, "کلید پیدا نشد.");
    return sendMsg(env, chat, `🔑 ${key}\n\n${r.value}\n\n💬 ${r.comment || "—"}`);
  }
  if (sub === "del") {
    if (!key) return sendMsg(env, chat, "فرمت: /db del <کلید>");
    await DB.dbDel(env, key);
    return sendMsg(env, chat, `🗑 حذف شد: ${key}`);
  }
  if (sub === "comment") {
    if (!key || !val) return sendMsg(env, chat, "فرمت: /db comment <کلید> <کامنت>");
    const r = await DB.dbGet(env, key);
    if (!r) return sendMsg(env, chat, "کلید پیدا نشد.");
    await DB.dbSet(env, key, r.value, val);
    return sendMsg(env, chat, "💬 کامنت ذخیره شد.");
  }
  if (sub === "list") {
    const items = await DB.dbList(env);
    if (!items.length) return sendMsg(env, chat, "دیتابیس خالیه. با /db set <کلید> <مقدار> شروع کن.");
    return sendMsg(env, chat, "🗄 دیتابیس:\n" + items.map((i) => {
      const v = String(i.value ?? "");
      return `• ${i.key} = ${v.slice(0, 40)}${v.length > 40 ? "…" : ""}${i.comment ? `   💬 ${String(i.comment).slice(0, 40)}` : ""}`;
    }).join("\n"));
  }
  return sendMsg(env, chat, "زیرفرمت‌ها: set / get / comment / list / del");
}

// ---------- wizard ----------
async function startWizard(env, chat) {
  await putW(env, chat, { step: "await_prompt", files: [] });
  return sendMsg(env, chat,
    "📝 پرامپت تسک رو بنویس — کامل و دقیق، مثل حرف زدن با یه برنامه‌نویس.\n(لغو: /cancel)");
}

async function finishFiles(env, chat) {
  const w = await getW(env, chat);
  if (!w || w.step !== "await_files") return;
  const models = await getModels(env);
  w.step = "await_model";
  await putW(env, chat, w);
  return sendMsg(env, chat,
    `🧠 مدل رایگان رو انتخاب کن (پیشنهادی: DeepSeek):\nفایل‌های ذخیره‌شده: ${(w.files || []).length}`,
    { reply_markup: modelKeyboard(models) });
}

async function confirmYes(env, chat) {
  const w = await getW(env, chat);
  if (!w || !w.prompt || !w.model) return sendMsg(env, chat, "اطلاعات تسک کامل نیست؛ دوباره /new بزن.");
  await delW(env, chat);
  await createTask(env, { prompt: w.prompt, model: w.model, files: w.files || [] });
}

async function onPlain(env, chat, text) {
  const w = await getW(env, chat);
  if (w) {
    switch (w.step) {
      case "await_prompt": {
        if (text.length < 5) return sendMsg(env, chat, "پرامپت خیلی کوتاهه؛ کامل‌تر بنویس. (لغو: /cancel)");
        w.prompt = text; w.step = "await_files"; w.files = w.files || [];
        await putW(env, chat, w);
        return sendMsg(env, chat,
          "✅ پرامپت ثبت شد.\nحالا فایل‌هات رو بفرست (تا ۱۵MB هر فایل). تمام شد؟ دکمه زیر یا /done. فایل نداری؟ «بدون فایل» یا /skip",
          { reply_markup: FILES_KB });
      }
      case "await_files":
        if (/^(\/done|done|تمام|تمام شد|ادامه)$/i.test(text)) return finishFiles(env, chat);
        if (/^(\/skip|skip|نه|رد شو|بدون فایل)$/i.test(text)) return finishFiles(env, chat);
        return sendMsg(env, chat, "فایل بفرست یا از دکمه‌ها استفاده کن (تمام شد / بدون فایل).", { reply_markup: FILES_KB });
      case "await_model":
        return sendMsg(env, chat, "یکی از مدل‌ها رو از دکمه‌های پیام قبل انتخاب کن.");
      case "await_confirm":
        if (/^(\/yes|بله|تایید|تأیید|ok|yes)$/i.test(text)) return confirmYes(env, chat);
        if (/^(\/no|نه|لغو|no)$/i.test(text)) { await delW(env, chat); return sendMsg(env, chat, "لغو شد."); }
        return sendMsg(env, chat, "شروع کنم؟ (بله / نه)", { reply_markup: CONFIRM_KB });
      case "await_target":
        return sendMsg(env, chat, "اول مقصد رو از دکمه‌های پیام قبل انتخاب کن یا /cancel بزن.");
    }
  }
  return offerTarget(env, chat, { text });
}

async function onFile(env, chat, m) {
  let fileId, name, size;
  if (m.document) {
    fileId = m.document.file_id;
    name = m.document.file_name || ("file-" + rid(4));
    size = m.document.file_size || 0;
  } else {
    const p = m.photo[m.photo.length - 1];
    fileId = p.file_id;
    name = `photo-${p.file_unique_id}.jpg`;
    size = p.file_size || 0;
  }
  const w = await getW(env, chat);

  // caption commands inside wizard
  if (w && w.step === "await_files" && m.caption && /^(\/done|done|تمام شد)$/i.test(m.caption.trim())) {
    return finishFiles(env, chat);
  }

  if (size > 15 * 1024 * 1024) {
    return sendMsg(env, chat, "⚠️ حجم فایل بیشتر از ۱۵ مگابایت است (محدودیت تلگرام برای دانلود).");
  }

  if (w && w.step === "await_files") {
    try {
      const bytes = await downloadTgFile(env, fileId);
      const key = "f:" + crypto.randomUUID();
      await env.KV.put(key, bufToB64(bytes), { expirationTtl: 48 * 3600 });
      w.files = w.files || [];
      w.files.push({ key, name, size: bytes.length });
      await putW(env, chat, w);
      return sendMsg(env, chat, `📎 «${name}» ذخیره شد (مجموع: ${w.files.length} فایل). فایل بعدی یا «تمام شد»؟`, { reply_markup: FILES_KB });
    } catch (e) {
      console.error("onFile dl", String(e));
      return sendMsg(env, chat, "⚠️ دانلود فایل از تلگرام ناموفق بود.");
    }
  }

  if (w && w.step !== "await_target") {
    return sendMsg(env, chat, "الان توی ویزارد تسک جدیدی؛ اول مرحله‌ها رو کامل کن یا /cancel بزن.");
  }
  if (w && w.step === "await_target") {
    return sendMsg(env, chat, "اول مقصد رو انتخاب کن (دکمه‌های پیام قبل) یا /cancel.");
  }

  // mid-task followup: store file now, then pick target task
  try {
    const bytes = await downloadTgFile(env, fileId);
    const key = "f:" + crypto.randomUUID();
    await env.KV.put(key, bufToB64(bytes), { expirationTtl: 48 * 3600 });
    return offerTarget(env, chat, { file: { key, name } });
  } catch (e) {
    console.error("onFile dl2", String(e));
    return sendMsg(env, chat, "⚠️ دانلود فایل ناموفق بود.");
  }
}

// ---------- followup routing ----------
async function activeTasks(env) {
  const all = await listTasks(env);
  return all.filter((t) => ["queued", "running"].includes(t.status));
}

async function offerTarget(env, chat, pending) {
  const active = await activeTasks(env);
  if (!active.length) {
    return sendMsg(env, chat, "تسک فعالی وجود نداره. با /new یه تسک جدید بساز 👇",
      { reply_markup: { inline_keyboard: [[{ text: "➕ تسک جدید", callback_data: "new" }]] } });
  }
  if (active.length === 1) return attachFollowup(env, chat, active[0], pending);
  const w = (await getW(env, chat)) || { step: "await_target" };
  w.step = "await_target";
  w.pending = pending;
  await putW(env, chat, w);
  return sendMsg(env, chat, "به کدوم تسک بفرستم؟", {
    reply_markup: { inline_keyboard: active.map((t) => [{ text: `${STATUS_EMO[t.status]} ${t.id} (${t.model})`, callback_data: `tgt:${t.id}` }]) },
  });
}

async function attachFollowup(env, chat, t, pending) {
  t.followups = t.followups || [];
  if (t.followups.length > 50) return sendMsg(env, chat, "صف پیام‌های این تسک پر شده.");
  t.followups.push({ text: pending.text || "", files: pending.file ? [pending.file] : [], at: Date.now() });
  await putTask(env, t);
  const desc = (pending.text ? "متن" + (pending.file ? "+فایل" : "") : "فایل");
  return sendMsg(env, chat, `📩 ${desc} به صف تسک ${t.id} اضافه شد — تا ~۲۰ ثانیه دیگه تحویل عامل میشه.`);
}

// ---------- callbacks ----------
async function onCb(env, cb) {
  const chat = cb.message?.chat?.id;
  const data = cb.data || "";
  const ack = () => tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  try {
    if (!chat || String(chat) !== String(env.ADMIN_CHAT_ID)) return await ack();

    if (data.startsWith("m:")) {
      const w = await getW(env, chat);
      if (!w || w.step !== "await_model") return await ack();
      w.model = data.slice(2);
      w.step = "await_confirm";
      await putW(env, chat, w);
      const pf = String(w.prompt || "");
      await sendMsg(env, chat,
        `🚀 آماده اجرا:\n\n📝 پرامپت: ${pf.slice(0, 400)}${pf.length > 400 ? "…" : ""}\n🧠 مدل: ${w.model}\n📁 فایل‌ها: ${(w.files || []).length}\n\nشروع کنم؟`,
        { reply_markup: CONFIRM_KB });
      return await ack();
    }
    if (data === "files:done" || data === "files:skip") return await finishFiles(env, chat) , await ack();
    if (data === "cfm:yes") return await confirmYes(env, chat), await ack();
    if (data === "cfm:no") { await delW(env, chat); await sendMsg(env, chat, "لغو شد."); return await ack(); }
    if (data === "new") return await startWizard(env, chat), await ack();
    if (data.startsWith("tgt:")) {
      const w = await getW(env, chat);
      const t = await getTask(env, data.slice(4));
      if (w?.step === "await_target" && t && ["queued", "running"].includes(t.status)) {
        await delW(env, chat);
        await attachFollowup(env, chat, t, w.pending || {});
        return await ack();
      }
      return await ack();
    }
    if (data.startsWith("kil:")) { const t = await getTask(env, data.slice(4)); if (t) await stopTask(env, t, "kill"); return await ack(); }
    if (data.startsWith("end:")) { const t = await getTask(env, data.slice(4)); if (t) await stopTask(env, t, "end"); return await ack(); }
    return await ack();
  } catch (e) {
    console.error("onCb", data, String(e));
    try { await ack(); } catch {}
  }
}
