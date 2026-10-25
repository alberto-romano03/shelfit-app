// Path-prefix awareness for hosting shelfIt under a sub-path (e.g. /shelfit) so
// several apps can share one hostname, each behind its own /prefix.
//
// The reverse proxy (see Caddyfile `handle_path /shelfit/*`) STRIPS the prefix
// before forwarding, so the backend still serves everything at root. The browser
// however sits at …/shelfit/…, so every ROOT-ABSOLUTE URL the client emits must
// carry the prefix — otherwise it resolves to the origin root and misses Caddy's
// route. These helpers add/remove it in the few choke points that emit URLs.
//
// BASE is derived from Vite's `base` config (vite.config.js → base: '/shelfit/')
// so there is a single source of truth: change it there and everything follows.

export const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

// Prefix a root-absolute path ("/api/…", "/assets/…") with BASE. Leaves relative
// paths, blob:/data:/http(s) URLs, and already-prefixed paths untouched, so it's
// safe to call more than once on the same value.
export function withBase(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return path;
  if (!BASE) return path;
  if (path === BASE || path.startsWith(BASE + '/')) return path;
  return BASE + path;
}

// Inverse of withBase for a location.pathname → a root-relative route the router
// can match ("/shelfit/season/5/1" → "/season/5/1", "/shelfit/" → "/").
export function stripBase(pathname) {
  if (typeof pathname !== 'string' || !BASE) return pathname;
  if (pathname === BASE) return '/';
  if (pathname.startsWith(BASE + '/')) return pathname.slice(BASE.length) || '/';
  return pathname;
}
