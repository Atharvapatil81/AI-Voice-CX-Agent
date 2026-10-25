// GET /api/orders -> the mock order table, so the "Test Orders" panel in the
// UI is rendered from the same data the agent's tools use.
import { ORDERS } from '../lib/orders.js';
import { getConfig } from '../lib/groq.js';
import { sendJson } from '../lib/http.js';

export default function handler(req, res) {
  sendJson(res, 200, {
    orders: Object.values(ORDERS),
    configured: Boolean(getConfig().apiKey),
    model: getConfig().model,
  });
}
