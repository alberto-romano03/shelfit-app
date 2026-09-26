// API-usage dashboard under /api/usage: reports per-API monthly usage against
// self-imposed budgets, sets each API's monthly cap, and toggles a session-only
// emergency bypass. The budgets are internal — TMDB / Fanart.tv publish no quota.

import { stats, setCap, setBypass, API_LIST } from '../usage.js';

// API-usage dashboard endpoints. All figures are self-imposed budgets (see
// usage.js) — TMDB/Fanart.tv don't publish monthly quotas.
export default async function usageRoutes(fastify) {
  // GET /api/usage → per-API { used, cap, blocked, bypassed, ... } for the month.
  fastify.get('/api/usage', async () => {
    return { usage: stats() };
  });

  // PATCH /api/usage/:api → { cap } sets the monthly budget (0 = unlimited).
  fastify.patch('/api/usage/:api', async (request, reply) => {
    const api = request.params.api;
    if (!API_LIST.includes(api)) {
      reply.code(404);
      return { error: 'unknown api' };
    }
    const body = request.body || {};
    if (body.cap !== undefined) setCap(api, body.cap);
    return { usage: stats() };
  });

  // POST /api/usage/:api/bypass → { on } toggles the session-only emergency
  // bypass (ignores the cap until the server restarts; the saved cap is unchanged).
  fastify.post('/api/usage/:api/bypass', async (request, reply) => {
    const api = request.params.api;
    if (!API_LIST.includes(api)) {
      reply.code(404);
      return { error: 'unknown api' };
    }
    const body = request.body || {};
    setBypass(api, !!body.on);
    return { usage: stats() };
  });
}
