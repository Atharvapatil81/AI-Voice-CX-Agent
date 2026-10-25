// Local / Render server: serves public/ and routes /api/* to the same
// handlers Vercel uses. Zero dependencies.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (only for local dev; hosts inject env vars themselves).
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const { default: chat } = await import('./api/chat.js');
const { default: summary } = await import('./api/summary.js');
const { default: orders } = await import('./api/orders.js');
const ROUTES = { '/api/chat': chat, '/api/summary': summary, '/api/orders': orders };

const PUBLIC = join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = ROUTES[url.pathname];
  if (route) {
    try {
      return await route(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end('Server error');
      return;
    }
  }

  const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Aura voice agent running at http://localhost:${port}`);
  if (!process.env.GROQ_API_KEY) console.warn('Warning: GROQ_API_KEY is not set — copy .env.example to .env and add your key.');
});
