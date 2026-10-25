// Tiny helpers shared by the Vercel functions (api/*) and the local server.
// Handlers use only the plain Node req/res API so they run on both.

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

/** Vercel pre-parses JSON into req.body; the local server does the same. Fall back to reading the stream. */
export async function readJson(req, limit = 100_000) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

// Best-effort, in-memory, per-instance rate limit. Enough to stop a public
// demo key being drained by a loop; a real deployment would use Redis.
const hits = new Map();
export function rateLimited(req, { key, limit, windowMs = 60_000 }) {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim();
  const id = `${key}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(id, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > limit;
}
