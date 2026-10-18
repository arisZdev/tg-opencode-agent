// ---------- bale.ai bot api helpers ----------
// Bale Bot API is Telegram-compatible: base https://tapi.bale.ai/bot<token>/<method>
// Docs: https://docs.bale.ai/  (webhook ports 443/88, inline keyboards supported)
import { chunkText } from "./util.js";

const base = (env) => `${env.BALE_API || "https://tapi.bale.ai"}/bot${env.BALE_BOT_TOKEN}`;
export const baleEnabled = (env) => !!env.BALE_BOT_TOKEN;

export async function bale(env, method, payload) {
  if (!baleEnabled(env)) return { ok: false, description: "bale not configured" };
  try {
    const r = await fetch(`${base(env)}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({ ok: false }));
    if (!j.ok) console.error("BALE", method, JSON.stringify(j).slice(0, 300));
    return j;
  } catch (e) {
    console.error("BALE", method, String(e));
    return { ok: false, description: String(e) };
  }
}

export async function sendMsg(env, chat, txt, extra = {}) {
  if (!baleEnabled(env)) return { ok: false, description: "bale not configured" };
  const parts = chunkText(txt, 3500);
  let last = { ok: false };
  for (const p of parts) {
    const payload = { chat_id: chat, text: p };
    if (extra.reply_markup) payload.reply_markup = extra.reply_markup;
    last = await bale(env, "sendMessage", payload);
    // defensive: if Bale rejects the keyboard shape, retry as plain text
    if (!last.ok && extra.reply_markup) {
      last = await bale(env, "sendMessage", { chat_id: chat, text: p });
    }
  }
  return last;
}

export async function sendDoc(env, chat, bytes, filename, caption = "") {
  if (!baleEnabled(env)) return { ok: false, description: "bale not configured" };
  try {
    const fd = new FormData();
    fd.append("chat_id", String(chat));
    if (caption) fd.append("caption", caption.slice(0, 900));
    fd.append("document", new Blob([bytes]), filename);
    const r = await fetch(`${base(env)}/sendDocument`, { method: "POST", body: fd });
    const j = await r.json().catch(() => ({ ok: false }));
    if (!j.ok) console.error("BALE sendDocument", JSON.stringify(j).slice(0, 300));
    return j;
  } catch (e) {
    console.error("BALE sendDocument", String(e));
    return { ok: false, description: String(e) };
  }
}

export async function downloadFile(env, fileId) {
  const g = await bale(env, "getFile", { file_id: fileId });
  if (!g.ok || !g.result?.file_path) throw new Error("bale getFile failed: " + JSON.stringify(g).slice(0, 200));
  const origin = new URL(base(env)).origin;
  const r = await fetch(`${origin}/file/bot${env.BALE_BOT_TOKEN}/${g.result.file_path}`);
  if (!r.ok) throw new Error("bale file download failed: " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
