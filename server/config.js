import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root: server/ lives directly under it.
export const ROOT_DIR = path.resolve(__dirname, '..');

// Everything persistent lives under data/ (the Docker volume). SHELFIT_DATA_DIR
// points it elsewhere; the test suite uses it so a run can never touch real data.
export const DATA_DIR = process.env.SHELFIT_DATA_DIR
  ? path.resolve(process.env.SHELFIT_DATA_DIR)
  : path.join(ROOT_DIR, 'data');
export const DB_PATH = path.join(DATA_DIR, 'shelfit.db');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const BADGES_DIR = path.join(DATA_DIR, 'badges');
export const IMPORT_DIR = path.join(DATA_DIR, 'import');
// Holds a single user-uploaded profile photo (fixed name, replaced on update).
export const PROFILE_DIR = path.join(DATA_DIR, 'profile');
// Database snapshots, incl. the automatic one taken before every schema migration.
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');

// Parse a positive-integer env var, falling back (with a warning) to `fallback`
// when it is missing or malformed — so a typo'd PORT/cache-age becomes a clear
// boot-time message instead of a NaN that silently breaks listen()/cache math.
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    // eslint-disable-next-line no-console
    console.warn(`config: ${name}="${raw}" is not a positive integer — using ${fallback}`);
    return fallback;
  }
  return n;
}

export const PORT = intEnv('PORT', 3000);
export const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// Origin the user's other devices reach the app at (the host's Tailscale name,
// or a DDNS address), e.g. "https://myserver.tail1234.ts.net": no trailing
// slash, no sub-path. Used to build magic-link URLs the user copies to another
// device; a localhost/LAN address would be useless there. When unset, the
// magic-link generator falls back to the external host/proto the proxy forwards.
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
export const FANART_API_KEY = process.env.FANART_API_KEY || '';

export const CACHE_MAX_AGE_DAYS_MOVIES = intEnv('CACHE_MAX_AGE_DAYS_MOVIES', 180);
export const CACHE_MAX_AGE_DAYS_SHOWS = intEnv('CACHE_MAX_AGE_DAYS_SHOWS', 7);

// Upper bound for an operator-placed import file (CSV/XML). These are read whole
// into memory, so cap them to avoid an OOM on a pathological/corrupt export.
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

// Global minimum spacing (ms) between TMDB calls during a bulk import, so a run
// stays under TMDB's rate limit. Applied by every importer via setMinInterval.
export const TMDB_IMPORT_INTERVAL_MS = 250;
