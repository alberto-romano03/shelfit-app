// Share Target endpoint: GET /share (browser-facing /shelfit/share). Registered
// as an OS share target in manifest.json, so the user can share a TMDB link — or
// any text — from another app or browser straight into shelfIt. It parses a TMDB
// movie/tv URL down to its id and redirects into the SPA with a query parameter
// the client acts on:
//   • TMDB id found   → /shelfit/?open=<type>:<tmdbId>   (opens that title)
//   • only text/title → /shelfit/?search=<text>          (pre-fills the search)
//   • nothing usable  → /shelfit/                         (home, silently)
//
// It lives behind the auth gate like any page navigation: a logged-in share opens
// the title; a logged-out one lands on the login page first (the session cookie is
// SameSite=Lax, so it rides along on this top-level GET). The service worker lets
// this navigation reach the backend instead of shadowing it with the cached shell.

// The app is served under this sub-path by the reverse proxy, which STRIPS the
// prefix before forwarding — so the incoming path is /share, but every URL we
// hand back to the browser must carry the prefix. Keep in sync with Caddy / BASE.
const BASE = '/shelfit';

// Extract { type, tmdbId } from a themoviedb.org movie/tv URL. Handles the plain
// id and the slug form (…/movie/123-the-title), http/https, and www/no-www.
// TMDB's 'tv' maps to shelfIt's 'show'. Returns null when no id can be found.
export function parseTmdbUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const m = raw.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
  if (!m) return null;
  return { type: m[1].toLowerCase() === 'tv' ? 'show' : 'movie', tmdbId: m[2] };
}

export default async function shareRoutes(fastify) {
  fastify.get('/share', async (request, reply) => {
    const q = request.query || {};
    // A shared item may arrive as `url`, or with the link buried in `text`
    // (Android often puts the URL there) or `title`. Scan all three for a link.
    const candidates = [q.url, q.text, q.title].filter(
      (v) => typeof v === 'string' && v
    );
    let hit = null;
    for (const c of candidates) {
      hit = parseTmdbUrl(c);
      if (hit) break;
    }
    if (hit) {
      const token = encodeURIComponent(`${hit.type}:${hit.tmdbId}`);
      return reply.redirect(`${BASE}/?open=${token}`);
    }

    // No TMDB link — fall back to a search seeded with the shared title or text.
    const title = typeof q.title === 'string' ? q.title.trim() : '';
    const text = typeof q.text === 'string' ? q.text.trim() : '';
    const term = title || text;
    if (term) {
      return reply.redirect(`${BASE}/?search=${encodeURIComponent(term)}`);
    }

    // Nothing usable was shared → land on the home screen silently.
    return reply.redirect(`${BASE}/`);
  });
}
