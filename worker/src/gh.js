// ---------- github api helper ----------
export async function gh(env, path, method = "GET", body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `token ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "tg-opencode-agent",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { /* 204 etc */ }
  if (!r.ok) console.error("GH", method, path, r.status, JSON.stringify(j).slice(0, 300));
  return { ok: r.ok, status: r.status, j };
}
