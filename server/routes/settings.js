// App-level settings that live server-side (as opposed to the client's own
// localStorage preferences). Currently one: the language shelfIt asks TMDB for.
//
// Changing it is not just a flag flip — every cached meta.json holds titles,
// overviews and episode names in the OLD language, and `items.title_it` (what
// the grids, lists and search read) was copied from it when the title was added.
// So the PATCH below also rebuilds the library's cached metadata and rewrites
// those stored titles. It is the same force-refresh the Advanced tab already
// does for ongoing series, just across the whole library.
import db from '../db.js';
import {
  TMDB_LANGUAGES,
  getTmdbLanguage,
  setTmdbLanguage,
} from '../language.js';
import { ensureCached, readMetaSync, wrongLanguage } from '../cache.js';

const allItemsStmt = db.prepare(
  'SELECT id, tmdb_id, type FROM items ORDER BY type, id'
);
const updateTitlesStmt = db.prepare(
  'UPDATE items SET title_it = ?, title_orig = ? WHERE id = ?'
);

// How many cached titles are currently written in another language — what the
// Settings row shows as "N titles will be refreshed".
function staleCount() {
  let stale = 0;
  for (const row of allItemsStmt.all()) {
    const meta = readMetaSync(row.type, row.tmdb_id);
    if (meta && wrongLanguage(meta)) stale += 1;
  }
  return stale;
}

export default async function settingsRoutes(fastify) {
  // GET /api/settings/metadata-language → current choice + what is available.
  fastify.get('/api/settings/metadata-language', async () => ({
    language: getTmdbLanguage(),
    languages: TMDB_LANGUAGES,
    stale: staleCount(),
  }));

  // PATCH /api/settings/metadata-language { language }
  // Sets the language and re-fetches every title in the new one. Returns the
  // counts so the UI can report what happened.
  fastify.patch('/api/settings/metadata-language', async (request, reply) => {
    const { language } = request.body || {};
    if (!TMDB_LANGUAGES.includes(language)) {
      reply.code(400);
      return { error: `language must be one of: ${TMDB_LANGUAGES.join(', ')}` };
    }

    let changed;
    try {
      changed = setTmdbLanguage(language);
    } catch (err) {
      reply.code(err.statusCode || 400);
      return { error: err.message };
    }
    if (!changed) {
      return { ok: true, language, changed: false, refreshed: 0, failed: 0, total: 0 };
    }

    // Rebuild the cache title by title. Failures are logged and counted rather
    // than aborting the run: one unreachable title must not leave the rest of
    // the library half-translated.
    const items = allItemsStmt.all();
    let refreshed = 0;
    let failed = 0;
    for (const row of items) {
      try {
        const meta = await ensureCached(row.type, row.tmdb_id, { force: true });
        if (meta) {
          updateTitlesStmt.run(
            meta.title_it || meta.title_orig || 'Untitled',
            meta.title_orig || meta.title_it || 'Untitled',
            row.id
          );
        }
        refreshed += 1;
      } catch (err) {
        failed += 1;
        fastify.log.warn(
          `metadata-language refresh failed for ${row.type} ${row.tmdb_id}: ${err.message}`
        );
      }
    }

    fastify.log.info(
      `metadata language set to ${language}: ${refreshed} refreshed, ${failed} failed`
    );
    return { ok: true, language, changed: true, refreshed, failed, total: items.length };
  });
}
