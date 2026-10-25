// POST /api/chat  { messages: [...] }  ->  NDJSON stream of agent events.
import { runAgent, sanitizeMessages } from '../lib/agent.js';
import { readJson, sendJson, rateLimited } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  if (rateLimited(req, { key: 'chat', limit: 40 })) return sendJson(res, 429, { error: 'Too many requests, slow down.' });

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: 'Invalid JSON body' });
  }
  const messages = sanitizeMessages(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return sendJson(res, 400, { error: 'Last message must be from the user.' });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Stop generating (and paying for tokens) if the customer barges in and the
  // browser aborts the request.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const emit = (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + '\n');
  };

  try {
    await runAgent({ messages, emit, signal: controller.signal });
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[chat]', err);
      emit({ type: 'error', message: 'server_error' });
    }
  }
  if (!res.writableEnded) res.end();
}
