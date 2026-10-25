// Statistics endpoint: GET /api/stats returns the cached lifetime statistics
// summary computed in stats.js.

import db from '../db.js';
import { getStats } from '../stats.js';

export default async function statsRoutes(fastify) {
  // GET /api/stats → returns the cached statistics summary.
  fastify.get('/api/stats', async (request) => {
    return getStats(db, request.user.id);
  });
}
