// Thin fetch wrapper toward the backend.
//
// `api` is the default client (no cancellation). Views that fetch on load
// should use `createApi(signal)` with a per-view AbortController so their
// in-flight requests are cancelled when the user navigates away.

import { reportServerUp, reportServerSuspect } from './network.js';
import { withBase } from './basePath.js';
import { t } from './i18n.js';

// True for fetch aborts (navigation teardown) — callers ignore these silently.
export function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 20);
}

// Transient-failure retry for idempotent reads. A GET can fail at the transport
// level for reasons that have nothing to do with the server being down — most
// commonly a persistent (keep-alive) connection the server closed just as the
// browser reused it for the next request, which surfaces as a bare "Failed to
// fetch" and succeeds immediately on a fresh socket. This is exactly the blip
// that used to flash the offline toast right after a write's follow-up read. We
// retry a couple of times with a short ramp; only GETs are eligible because
// replaying a POST/PATCH/DELETE could double-apply a mutation.
const RETRY_MAX_ATTEMPTS = 3; // 1 initial try + 2 retries
const RETRY_BACKOFF_MS = 150; // ramps: 150ms, then 300ms
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Monotonic counter bumped whenever any mutation succeeds (across every client).
// The GET de-dup map stamps each in-flight request with the value at its start
// and only reuses one whose stamp still matches — so a read issued after a write
// (e.g. the refetch a mutation's 'shelfit:library-changed' triggers) never
// attaches to, and inherits the pre-write result of, a GET that was already in
// flight when the write landed.
let writeGeneration = 0;

function buildApi(signal) {
  // Per-client de-duplication of identical concurrent GETs: if the same URL is
  // requested again while one is still in flight, both callers share the single
  // request/response instead of firing a duplicate (e.g. a grid's plan warm and
  // its offline-fallback both hitting /api/plan-to-watch). Scoped per client so
  // every in-flight request shares this client's one abort signal.
  const inflight = new Map(); // url -> { p: Promise, gen: number }

  function request(method, url, body) {
    if (method !== 'GET') return doRequest(method, url, body);
    // Reuse an in-flight identical GET only if no mutation has committed since it
    // started (its generation stamp still matches) — otherwise a post-write
    // refetch could receive that pre-write GET's stale result.
    const entry = inflight.get(url);
    if (entry && entry.gen === writeGeneration) return entry.p;
    const gen = writeGeneration;
    const p = doRequest(method, url, body).finally(() => {
      // Only evict our own entry — a newer GET (post-mutation) may already have
      // replaced it under the same URL and must not be cleared by our teardown.
      const cur = inflight.get(url);
      if (cur && cur.p === p) inflight.delete(url);
    });
    inflight.set(url, { p, gen });
    return p;
  }

  async function doRequest(method, url, body) {
    const opts = { method, headers: {} };
    if (signal) opts.signal = signal;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    // Only idempotent GETs may be transparently retried; a write is issued once.
    const maxAttempts = method === 'GET' ? RETRY_MAX_ATTEMPTS : 1;
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(withBase(url), opts);
        break;
      } catch (err) {
        if (isAbortError(err)) throw err; // navigation teardown — never retry
        // A transient transport failure (e.g. a keep-alive socket the server
        // closed as we reused it). Back off briefly and retry on a fresh
        // connection before concluding anything about reachability.
        if (attempt < maxAttempts && !(signal && signal.aborted)) {
          await delay(RETRY_BACKOFF_MS * attempt);
          continue;
        }
        // Retries exhausted (or a non-retryable method): the server MAY be
        // unreachable, but a single failure isn't proof — let network.js confirm
        // with a health probe instead of flipping the UI offline on this alone.
        reportServerSuspect();
        throw err;
      }
    }
    // A service-worker cached fallback is NOT proof the server is up; only real
    // responses drive reachability. A 5xx is a real answer but may be a one-off
    // upstream blip, so it too goes through the confirming probe rather than a
    // hard flip.
    if (!res.headers.get('X-Shelfit-Offline')) {
      if (res.status >= 500) reportServerSuspect();
      else reportServerUp();
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json();
    }
    if (!res.ok) {
      // Session expired / not authenticated → bounce to the login page.
      if (res.status === 401) window.location.href = withBase('/login');
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    // A successful mutation may have changed library data — let cached views
    // (e.g. the Movies/Series grid) invalidate. GETs never mutate, so pure
    // navigation keeps caches warm. Bump the generation BEFORE dispatching so any
    // refetch the event triggers can't reuse a GET that predates this write.
    if (method !== 'GET') {
      writeGeneration++;
      window.dispatchEvent(new CustomEvent('shelfit:library-changed'));
    }
    return data;
  }

  const api = {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    patch: (url, body) => request('PATCH', url, body),
    del: (url, body) => request('DELETE', url, body),
    put: (url, body) => request('PUT', url, body),

    // Convenience helpers
    // `scope: 'library'` searches the user's own rows instead of TMDB.
    search: (q, type, scope) =>
      api.get(
        `/api/search?q=${encodeURIComponent(q)}&type=${type}` +
          (scope ? `&scope=${scope}` : '')
      ),
    media: (query = '') => api.get(`/api/media${query}`),
    // Paginated library slice for the virtual poster grids (additive; the server
    // returns total/page/pageSize/totalPages, plus groups + genres on page 1).
    // `status: 'all'` (or falsy) omits the status filter so every status is
    // included, matching the grid's "All" chip.
    mediaPage: (type, { status, genre, sort, owned, page, pageSize }) => {
      const p = new URLSearchParams();
      if (type) p.set('type', type);
      if (status && status !== 'all') p.set('status', status);
      if (owned) p.set('owned', '1');
      if (genre) p.set('genre', genre);
      if (sort) p.set('sort', sort);
      p.set('page', page);
      p.set('pageSize', pageSize);
      return api.get(`/api/media?${p.toString()}`);
    },
    mediaDetail: (id) => api.get(`/api/media/${id}`),
    preview: (type, tmdbId) => api.get(`/api/preview/${type}/${tmdbId}`),
    season: (id, n) => api.get(`/api/media/${id}/season/${n}`),
    // Paginated season fetch (additive; the server returns total/page/pageSize/
    // totalPages alongside the requested slice). Used by the virtual episode list.
    seasonPage: (id, n, page, pageSize) =>
      api.get(`/api/media/${id}/season/${n}?page=${page}&pageSize=${pageSize}`),
    addMedia: (tmdb_id, type, status) =>
      api.post('/api/media', { tmdb_id, type, status }),
    updateMedia: (id, body) => api.patch(`/api/media/${id}`, body),
    deleteMedia: (id) => api.del(`/api/media/${id}`),
    // Movie watch-date + rewatch events (movies only).
    setWatchDate: (id, date) => api.patch(`/api/media/${id}/watch-date`, { date }),
    addRewatch: (id, date) => api.post(`/api/media/${id}/rewatch`, { date }),
    deleteRewatch: (id, rewatchId) => api.del(`/api/media/${id}/rewatch/${rewatchId}`),
    rewatches: (id) => api.get(`/api/media/${id}/rewatches`),

    markEpisode: (item_id, season, episode, notes) =>
      api.post('/api/progress', { item_id, season, episode, notes }),
    catchUpEpisodes: (item_id, season, episode) =>
      api.post('/api/progress/catchup', { item_id, season, episode }),
    rewatchEpisode: (item_id, season, episode) =>
      api.post('/api/progress/rewatch', { item_id, season, episode }),
    // Set an episode's watch count to an absolute value; 0 fully unwatches it.
    // Returns the resulting watch_count (0 = removed).
    setEpisodeCount: (item_id, season, episode, watch_count) =>
      api.post('/api/progress/set-count', { item_id, season, episode, watch_count }),
    unwatchEpisode: (item_id, season, episode) =>
      api.del(`/api/progress/${item_id}/${season}/${episode}`),
    episodeNotes: (item_id, season, episode, notes) =>
      api.patch(`/api/progress/${item_id}/${season}/${episode}`, { notes }),
    markSeason: (item_id, season) =>
      api.post('/api/progress/season', { item_id, season }),
    unmarkSeason: (item_id, season) =>
      api.del('/api/progress/season', { item_id, season }),

    shelfRandom: (type, count = 1) =>
      api.get(`/api/shelf/random?count=${count}&type=${type}`),

    collections: () => api.get('/api/collections'),
    collectionDetail: (id) => api.get(`/api/collections/${id}`),

    genres: () => api.get('/api/genres'),
    discover: (body) => api.post('/api/discover', body),
    explore: () => api.get('/api/explore'),

    // API-usage dashboard (self-imposed monthly budgets — see server/usage.js).
    usage: () => api.get('/api/usage'),
    setUsageCap: (name, cap) => api.patch(`/api/usage/${name}`, { cap }),
    usageBypass: (name, on) => api.post(`/api/usage/${name}/bypass`, { on }),

    lists: (query = '') => api.get(`/api/lists${query}`),
    createList: (name, type) => api.post('/api/lists', { name, type }),
    renameList: (id, name) => api.patch(`/api/lists/${id}`, { name }),
    deleteList: (id) => api.del(`/api/lists/${id}`),
    listItems: (id) => api.get(`/api/lists/${id}/items`),
    addListItem: (id, tmdbId) => api.post(`/api/lists/${id}/items`, { tmdbId }),
    removeListItem: (id, tmdbId) => api.del(`/api/lists/${id}/items/${tmdbId}`),

    stats: () => api.get('/api/stats'),
    planToWatch: () => api.get('/api/plan-to-watch'),
    unrated: () => api.get('/api/unrated'),
    upcoming: () => api.get('/api/upcoming'),
    profile: () => api.get('/api/profile'),
    updateProfile: (body) => api.patch('/api/profile', body),
    ratedTitles: () => api.get('/api/profile/rated'),
    favoriteTitles: () => api.get('/api/profile/favorites'),
    badges: () => api.get('/api/badges'),

    // Raw image upload for the custom profile photo (bypasses the JSON wrapper).
    uploadProfilePhoto: async (file) => {
      const opts = {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      };
      if (signal) opts.signal = signal;
      const res = await fetch(withBase('/api/profile/photo'), opts);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    },
    deleteProfilePhoto: () => api.del('/api/profile/photo'),

    // Monthly Rental Receipt. Omit `month` for the current month; pass a
    // 'YYYY-MM' key to build that (past) month's receipt instead.
    receipt: (month) =>
      api.get(`/api/receipt${month ? `?month=${encodeURIComponent(month)}` : ''}`),

    // Cinema ticket collection (movies flagged watched_in_cinema). The flag
    // itself is toggled via updateMedia(id, { watched_in_cinema }).
    cinemaTickets: () => api.get('/api/cinema/tickets'),
    cinemaList: () => api.get('/api/cinema/list'),
    updateCinema: (id, body) => api.patch(`/api/movies/${id}/cinema`, body),

    // "The Wall" home favourites: the one pinned movie / show / person. Distinct
    // from favoriteTitles() above (the per-title hearts). Pass null to clear.
    favorites: () => api.get('/api/favorites'),
    setFavoriteMovie: (tmdbId) => api.patch(`/api/favorites/movie/${tmdbId ?? 'null'}`),
    setFavoriteShow: (tmdbId) => api.patch(`/api/favorites/show/${tmdbId ?? 'null'}`),
    setFavoritePerson: (tmdbId) => api.patch(`/api/favorites/person/${tmdbId ?? 'null'}`),

    // Person cache (server fetches from TMDB on a miss / after 7 days).
    person: (tmdbId) => api.get(`/api/persons/${tmdbId}`),
    personPhotoUrl: (tmdbId) => `/api/persons/${tmdbId}/photo`,
    deletePersonPhoto: (tmdbId) => api.del(`/api/persons/${tmdbId}/photo`),
    // Raw image upload for a person's custom photo (bypasses the JSON wrapper,
    // mirroring uploadProfilePhoto).
    uploadPersonPhoto: async (tmdbId, file) => {
      const opts = { method: 'POST', headers: { 'Content-Type': file.type }, body: file };
      if (signal) opts.signal = signal;
      const res = await fetch(withBase(`/api/persons/${tmdbId}/photo`), opts);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    },

    cacheStats: () => api.get('/api/admin/cache/stats'),
    clearAllCache: () => api.del('/api/admin/cache'),
    clearItemCache: (type, tmdb_id) =>
      api.del(`/api/admin/cache/${type}/${tmdb_id}`),
    refreshItem: (type, tmdb_id) =>
      api.post(`/api/admin/cache/${type}/${tmdb_id}/refresh`),
    refreshOngoing: () => api.post('/api/admin/cache/refresh-ongoing'),

    // Custom artwork (Detail options, "Customize metadata"). slot is one of
    // poster | backdrop | fanart.
    imageCandidates: (type, tmdb_id, slot) =>
      api.get(`/api/media/${type}/${tmdb_id}/images/${slot}`),
    // `image` is a data URL, already cropped to the slot's aspect ratio.
    setCustomImage: (type, tmdb_id, slot, image) =>
      api.put(`/api/media/${type}/${tmdb_id}/images/${slot}`, { image }),
    resetCustomImage: (type, tmdb_id, slot) =>
      api.del(`/api/media/${type}/${tmdb_id}/images/${slot}`),

    authStatus: () => api.get('/api/auth/status'),
    logout: () => api.post('/api/auth/logout'),
    // Invalidate every session on every device (including this one).
    logoutAll: () => api.post('/api/auth/logout-all'),
    // Recent authentication events (hashed identifiers only) for the Security panel.
    accessLog: () => api.get('/api/auth/access-log'),

    // This member's signed-in devices; any other one can be signed out.
    sessions: () => api.get('/api/auth/sessions'),
    revokeSession: (id) => api.del(`/api/auth/sessions/${id}`),

    // Household (master only). The invite URL is returned ONLY by addMember and
    // reinviteMember, once.
    householdMembers: () => api.get('/api/household/members'),
    addMember: (display_name) => api.post('/api/household/members', { display_name }),
    updateMember: (id, body) => api.patch(`/api/household/members/${id}`, body),
    reinviteMember: (id) => api.post(`/api/household/members/${id}/invite`),
    removeMember: (id) => api.del(`/api/household/members/${id}`),
    exportMember: async (id) => {
      const opts = { credentials: 'same-origin' };
      if (signal) opts.signal = signal;
      const res = await fetch(withBase(`/api/household/members/${id}/export`), opts);
      if (!res.ok) throw new Error(t('api.exportFailed', { status: res.status }));
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="?([^"]+)"?/);
      return { blob, filename: m ? m[1] : 'shelfit_library.xml' };
    },

    // Magic links (passwordless login). The token is returned ONLY by createMagic.
    magicLinks: () => api.get('/api/auth/magic'),
    createMagic: (label, expiry) => api.post('/api/auth/magic', { label, expiry }),
    revokeMagic: (id) => api.del(`/api/auth/magic/${id}`),

    importFiles: () => api.get('/api/import/files'),
    startImport: () => api.post('/api/import/tvtime'),
    importStatus: () => api.get('/api/import/status'),
    importLog: () => api.get('/api/import/log'),

    // Library backup: export downloads an XML file; import uploads the file's raw
    // XML text and returns a { added, merged, unchanged, fetches_queued, failures }.
    exportLibrary: async () => {
      const opts = { credentials: 'same-origin' };
      if (signal) opts.signal = signal;
      const res = await fetch(withBase('/api/library/export'), opts);
      if (!res.ok) throw new Error(t('api.exportFailed', { status: res.status }));
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="?([^"]+)"?/);
      return { blob, filename: m ? m[1] : 'shelfit_library.xml' };
    },
    importLibrary: async (xmlText) => {
      const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: xmlText,
      };
      if (signal) opts.signal = signal;
      const res = await fetch(withBase('/api/library/import'), opts);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error((data && data.error) || t('api.importFailed', { status: res.status }));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    },

    // Kodi integration (all Kodi contact happens server-side).
    kodiConfig: () => api.get('/api/kodi/config'),
    kodiIcons: () => api.get('/api/kodi/icons'),
    kodiSetEnabled: (enabled) => api.patch('/api/kodi/enabled', { enabled }),
    kodiCreateInstance: (body) => api.post('/api/kodi/instances', body),
    kodiUpdateInstance: (id, body) => api.patch(`/api/kodi/instances/${id}`, body),
    kodiDeleteInstance: (id) => api.del(`/api/kodi/instances/${id}`),
    kodiActivateInstance: (id) => api.post(`/api/kodi/instances/${id}/activate`),
    kodiTest: (body) => api.post('/api/kodi/test', body),
    kodiStatus: () => api.get('/api/kodi/status'),
    kodiNowPlaying: () => api.get('/api/kodi/now-playing'),
    kodiMatch: (tmdbId, type) =>
      api.get(`/api/kodi/match/${tmdbId}?type=${type}`),
    kodiPlay: (kodiId, type) => api.post('/api/kodi/play', { kodiId, type }),
    kodiSync: () => api.post('/api/kodi/sync'),
    kodiSyncClaim: () => api.post('/api/kodi/sync/claim'),
    kodiSyncCommit: (items) => api.post('/api/kodi/sync/commit', { items }),

    // Server-side app settings (as opposed to the client's own preferences).
    // Changing the metadata language re-fetches every title from TMDB, so the
    // PATCH can take a while on a large library — the caller shows progress.
    metadataLanguage: () => api.get('/api/settings/metadata-language'),
    setMetadataLanguage: (language) =>
      api.patch('/api/settings/metadata-language', { language }),

    // Push notifications (subscription lives server-side).
    pushConfig: () => api.get('/api/push/config'),
    pushSubscribe: (subscription) => api.post('/api/push/subscribe', { subscription }),
    pushUnsubscribe: () => api.post('/api/push/unsubscribe'),
    pushTest: () => api.post('/api/push/test'),
  };
  return api;
}

// Default client used by one-off actions (modals, etc.) that aren't tied to a
// page's lifecycle.
export const api = buildApi(null);

// A client whose every request carries `signal`; abort it to cancel them all.
export function createApi(signal) {
  return buildApi(signal);
}
