import { requestHandler } from '../server.mjs';

// Vercel catch-all Function.
// /api/health, /api/products, /api/orders, /api/admin/... all land here and are
// dispatched by the exact same router that server.mjs uses on long-running hosts.
export default function handler(req, res) {
  return requestHandler(req, res);
}
