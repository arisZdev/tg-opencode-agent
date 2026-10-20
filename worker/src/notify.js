// ---------- dual-channel notifications (telegram + bale) ----------
// The owner talks on both platforms; agent/task notifications go to BOTH.
import { sendMsg as tgSend, sendDoc as tgDoc } from "./tg.js";
import { sendMsg as baleSend, sendDoc as baleDoc, baleEnabled } from "./bale.js";

export async function notify(env, txt, extra = {}) {
  const tg = await tgSend(env, env.ADMIN_CHAT_ID, txt, extra);
  let bl = { ok: false, skipped: true };
  if (baleEnabled(env) && env.BALE_ADMIN_ID) {
    bl = await baleSend(env, env.BALE_ADMIN_ID, txt, extra);
  }
  return { tg, bale: bl };
}

export async function notifyDoc(env, bytes, name, caption = "") {
  const tg = await tgDoc(env, env.ADMIN_CHAT_ID, bytes, name, caption);
  let bl = { ok: false, skipped: true };
  if (baleEnabled(env) && env.BALE_ADMIN_ID) {
    bl = await baleDoc(env, env.BALE_ADMIN_ID, bytes, name, caption);
  }
  return { tg, bale: bl };
}
