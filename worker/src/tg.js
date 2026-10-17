// ---------- telegram api helpers ----------
import { chunkText } from "./util.js";

const url = (t, m) => `https://api.telegram.org/bot${t}/${m}`;

export async function tg(env, method, payload) {
  try {
    const r = await fetch(url(env.TG_BOT_TOKEN, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({ ok: false }));
    if (!j.ok) console.error("TG", method, JSON.stringify(j).slice(0, 300));
    return j;
  } catch (e) {
    console.error("TG", method, String(e));
    return { ok: false, description: String(e) };
  }
}

export async function sendMsg(env, chat, txt, extra = {}) {
  const parts = chunkText(txt);
  let last = { ok: false };
  for (const p of parts) {
    last = await tg(env, "sendMessage", {
      chat_id: chat,
      text: p,
      disable_web_page_preview: true,
      ...extra,
    });
  }
  return last;
}

export async function sendDoc(env, chat, bytes, filename, caption = "") {
  try {
    const fd = new FormData();
    fd.append("chat_id", String(chat));
    if (caption) fd.append("caption", caption.slice(0, 900));
    fd.append("document", new Blob([bytes]), filename);
    const r = await fetch(url(env.TG_BOT_TOKEN, "sendDocument"), { method: "POST", body: fd });
    const j = await r.json().catch(() => ({ ok: false }));
    if (!j.ok) console.error("TG sendDocument", JSON.stringify(j).slice(0, 300));
    return j;
  } catch (e) {
    console.error("TG sendDocument", String(e));
    return { ok: false, description: String(e) };
  }
}

export async function downloadTgFile(env, fileId) {
  const g = await tg(env, "getFile", { file_id: fileId });
  if (!g.ok || !g.result?.file_path) throw new Error("getFile failed: " + JSON.stringify(g).slice(0, 200));
  const r = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${g.result.file_path}`);
  if (!r.ok) throw new Error("file download failed: " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
