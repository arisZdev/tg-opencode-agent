// ---------- shared key/value database (db:<key> in KV) ----------
// user stores API keys & notes via /db commands; agent reads/writes via /agent/db endpoints

const K = (k) => `db:${k}`;

export async function dbSet(env, key, value, comment) {
  const existing = await env.KV.get(K(key), "json");
  const rec = {
    value: String(value ?? ""),
    comment: comment !== undefined ? String(comment) : (existing?.comment ?? ""),
    updated_at: Date.now(),
  };
  await env.KV.put(K(key), JSON.stringify(rec));
  return rec;
}

export async function dbGet(env, key) {
  return env.KV.get(K(key), "json");
}

export async function dbList(env) {
  const l = await env.KV.list({ prefix: "db:", limit: 300 });
  const out = [];
  for (const k of l.keys) {
    const key = k.name.slice(3);
    const v = await env.KV.get(k.name, "json");
    if (v) out.push({ key, ...v });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

export async function dbDel(env, key) {
  await env.KV.delete(K(key));
}
