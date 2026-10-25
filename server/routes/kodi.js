// Kodi integration HTTP API. Every endpoint lives behind shelfIt's own auth
// gate; the frontend calls only these — never Kodi directly. Hosts, ports and
// credentials never leave the server.

import {
  isEnabled,
  setEnabled,
  listInstances,
  getInstance,
  getActiveInstance,
  publicInstance,
  createInstance,
  updateInstance,
  deleteInstance,
  activateInstance,
  pingInstance,
  statusResponse,
  matchTitle,
  playOnKodi,
  listKodiIcons,
  nowPlaying,
  nowPlayingPoster,
} from '../kodi.js';
import {
  runKodiSync,
  commitKodiSync,
  getPendingCount,
  claimPending,
  syncOwnerId,
} from '../kodiSync.js';

function configPayload() {
  const active = getActiveInstance();
  return {
    enabled: isEnabled(),
    active_id: active ? active.id : null,
    active_name: active ? active.name : null,
    instances: listInstances().map(publicInstance),
  };
}

export default async function kodiRoutes(fastify) {
  // --- Configuration (settings UI) ----------------------------------------
  // Safe to call regardless of the enable toggle — pure DB reads, never touches
  // Kodi. Passwords are never included (only has_password).
  fastify.get('/api/kodi/config', async () => configPayload());

  // Selectable instance icons (SVGs the user placed in icons/kodi/).
  fastify.get('/api/kodi/icons', async () => ({ icons: listKodiIcons() }));

  // Enable / disable the whole integration.
  fastify.patch('/api/kodi/enabled', async (request) => {
    setEnabled(!!(request.body && request.body.enabled));
    return configPayload();
  });

  // Create an instance.
  fastify.post('/api/kodi/instances', async (request, reply) => {
    const b = request.body || {};
    const name = String(b.name || '').trim();
    const host = String(b.host || '').trim();
    if (!name || !host) {
      reply.code(400);
      return { error: 'name and host are required' };
    }
    createInstance({
      name,
      host,
      port: b.port,
      username: b.username,
      password: b.password,
      icon: b.icon,
    });
    return configPayload();
  });

  // Update an instance (blank password keeps the stored one).
  fastify.patch('/api/kodi/instances/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!getInstance(id)) {
      reply.code(404);
      return { error: 'instance not found' };
    }
    const b = request.body || {};
    updateInstance(id, {
      name: b.name !== undefined ? String(b.name).trim() : undefined,
      host: b.host !== undefined ? String(b.host).trim() : undefined,
      port: b.port,
      username: b.username,
      password: b.password,
      icon: b.icon,
    });
    return configPayload();
  });

  // Delete an instance.
  fastify.delete('/api/kodi/instances/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!deleteInstance(id)) {
      reply.code(404);
      return { error: 'instance not found' };
    }
    return configPayload();
  });

  // Set the active instance (atomic single-active).
  fastify.post('/api/kodi/instances/:id/activate', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!activateInstance(id)) {
      reply.code(404);
      return { error: 'instance not found' };
    }
    return configPayload();
  });

  // Test a connection. Accepts either a saved instance id (uses stored creds,
  // with an optional just-typed password override) or ad-hoc host/port/creds
  // from the add/edit form before it's saved.
  fastify.post('/api/kodi/test', async (request) => {
    const b = request.body || {};
    let instance;
    let overridePassword;
    if (b.id !== undefined && b.id !== null) {
      instance = getInstance(parseInt(b.id, 10));
      if (!instance) return { ok: false, error: 'instance not found' };
      // A password typed in the edit form overrides the stored one for the test.
      if (b.password) overridePassword = b.password;
    } else {
      if (!b.host) return { ok: false, error: 'host required' };
      instance = {
        host: String(b.host).trim(),
        port: Number(b.port) || 8080,
        username: b.username || '',
        password: null,
      };
      overridePassword = b.password || '';
    }
    const online = await pingInstance(instance, overridePassword);
    return { ok: online };
  });

  // --- Runtime (guarded: never contacts Kodi when off/no active instance) --
  // Status carries the count of discoveries waiting from a scheduled sync so the
  // client can raise the review card when it's ready (and no popup is open).
  fastify.get('/api/kodi/status', async (request) => {
    const s = await statusResponse();
    return { ...s, pending_review: getPendingCount(request.user.id) };
  });

  // Now Playing snapshot (drives the avatar ring, topbar indicator and panel).
  // Cheap + guarded; returns { active:false } when nothing is playing / Kodi off.
  fastify.get('/api/kodi/now-playing', async (request) => nowPlaying(request.user.id));

  // Proxy the currently-playing item's artwork from Kodi (used by the toast when
  // there's no local shelfIt poster — e.g. streaming add-ons). Streams the bytes
  // through so Kodi's host/port/credentials never reach the client.
  fastify.get('/api/kodi/now-playing/poster', async (request, reply) => {
    const art = await nowPlayingPoster();
    if (!art) {
      reply.code(404);
      return { error: 'no artwork' };
    }
    reply
      .header('Content-Type', art.contentType)
      .header('Cache-Control', 'private, max-age=120');
    return reply.send(art.buffer);
  });

  // --- Library sync -------------------------------------------------------
  // Manual sync — runs immediately and returns discoveries for review. If a sync
  // is already running (e.g. the scheduled one), it's reported and ignored.
  fastify.post('/api/kodi/sync', async () => {
    const res = await runKodiSync();
    return res;
  });

  // Claim discoveries stashed by the scheduled sync (returns and clears them).
  fastify.post('/api/kodi/sync/claim', async (request) => {
    const p = claimPending(request.user.id);
    return { discoveries: p ? p.discoveries : [] };
  });

  // Commit reviewed discoveries to the library.
  fastify.post('/api/kodi/sync/commit', async (request) => {
    const items = (request.body && request.body.items) || [];
    if (request.user.id !== syncOwnerId()) return { added: 0 };
    return commitKodiSync(items);
  });

  fastify.get('/api/kodi/match/:tmdbId', async (request) => {
    const type = request.query.type === 'movie' ? 'movie' : 'show';
    const kodiId = await matchTitle(request.params.tmdbId, type);
    return { match: kodiId != null ? kodiId : null };
  });

  fastify.post('/api/kodi/play', async (request, reply) => {
    const b = request.body || {};
    if (b.kodiId === undefined || b.kodiId === null) {
      reply.code(400);
      return { error: 'kodiId required' };
    }
    const type = b.type === 'movie' ? 'movie' : 'show';
    try {
      await playOnKodi(b.kodiId, type);
      return { ok: true };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: err.message || 'Playback failed' };
    }
  });
}
