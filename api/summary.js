// POST /api/summary  { transcript, startedAt, endedAt }  ->  structured call outcome JSON.
import { summarizeCall } from '../lib/summary.js';
import { readJson, sendJson, rateLimited } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  if (rateLimited(req, { key: 'summary', limit: 10 })) return sendJson(res, 429, { error: 'Too many requests, slow down.' });
  try {
    const body = await readJson(req, 300_000);
    const summary = await summarizeCall(body);
    sendJson(res, 200, summary);
  } catch (err) {
    console.error('[summary]', err);
    sendJson(res, err.status ?? 400, { error: 'Could not summarise this call.' });
  }
}
