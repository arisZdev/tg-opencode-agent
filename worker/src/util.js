// ---------- small helpers ----------
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function text(t, status = 200) {
  return new Response(t, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function rj(req) {
  try { return await req.json(); } catch { return {}; }
}

// short random id (no confusing chars)
export function rid(n = 8) {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += a[x % a.length];
  return s;
}

// long random token
export function tok() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

// split long text into telegram-sized chunks
export function chunkText(s, n = 3800) {
  const out = [];
  let r = String(s ?? "");
  if (!r.length) return [""];
  while (r.length > n) {
    let cut = r.lastIndexOf("\n", n);
    if (cut < n * 0.5) cut = n;
    out.push(r.slice(0, cut));
    r = r.slice(cut);
  }
  if (r.length) out.push(r);
  return out;
}

export function bufToB64(bytes) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export function b64ToBuf(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
