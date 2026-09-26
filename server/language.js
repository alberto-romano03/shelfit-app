// The language shelfIt asks TMDB for: titles, overviews, taglines, episode
// names, biographies. It was hard-coded to Italian until this became a setting,
// so the app can be run in either language without a rebuild.
//
// Two languages are offered, matching the UI's own (see client/src/i18n.js).
// English is the default: it is what TMDB is most complete in, and a new install
// has nothing cached yet, so the first fetch already lands in the right language.
//
// Changing it makes every cached meta.json stale — the cache stamps the language
// it was fetched in (`lang`), and cache.js refetches when that no longer matches
// (see cacheMovie/cacheShow). The Settings action also force-refreshes the whole
// library so the stored titles change over immediately rather than title by title.
import db from './db.js';

export const TMDB_LANGUAGES = ['en-US', 'it-IT'];
export const DEFAULT_TMDB_LANGUAGE = 'en-US';

const KEY = 'tmdb_language';

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

// Read once and keep in memory: this is consulted on every TMDB call, and the
// only writer is setTmdbLanguage() below (single process, single user).
let cached = null;

export function getTmdbLanguage() {
  if (cached) return cached;
  try {
    const row = getStmt.get(KEY);
    if (TMDB_LANGUAGES.includes(row && row.value)) {
      cached = row.value;
    } else {
      // No stored choice yet. A NEW install gets the English default. An install
      // that predates this setting already has a library cached in Italian (the
      // language that used to be hard-coded), so adopt it-IT for it instead:
      // otherwise every cached record would count as stale and the library would
      // re-translate itself title by title without anyone asking for it.
      cached = hasExistingLibrary() ? 'it-IT' : DEFAULT_TMDB_LANGUAGE;
      setStmt.run(KEY, cached);
    }
  } catch {
    cached = DEFAULT_TMDB_LANGUAGE;
  }
  return cached;
}

// True when this database already holds titles, i.e. it is an upgrade rather
// than a fresh install. Used once, by the migration above.
function hasExistingLibrary() {
  try {
    return !!db.prepare('SELECT 1 FROM items LIMIT 1').get();
  } catch {
    return false; // table not created yet — brand new database
  }
}

// The language used to fill an empty overview/biography. TMDB's localized
// records are often partial, so the other supported language is the fallback.
export function fallbackTmdbLanguage() {
  return getTmdbLanguage() === 'en-US' ? 'it-IT' : 'en-US';
}

// Returns true when the value actually changed (so the caller knows whether a
// library refresh is needed).
export function setTmdbLanguage(language) {
  if (!TMDB_LANGUAGES.includes(language)) {
    const err = new Error('unsupported language');
    err.statusCode = 400;
    throw err;
  }
  const previous = getTmdbLanguage();
  if (previous === language) return false;
  setStmt.run(KEY, language);
  cached = language;
  return true;
}
