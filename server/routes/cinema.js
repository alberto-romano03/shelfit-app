// Cinema ticket collection endpoints.
//
//   GET   /api/cinema/tickets      → every movie flagged watched_in_cinema, with
//                                     its cached backdrop and any stored date/time/name.
//   GET   /api/cinema/list         → the configurable list of cinema names (from
//                                     data/cinemas.txt) that populates the ticket's
//                                     cinema-name selector.
//   PATCH /api/movies/:id/cinema   → set/clear a movie's cinema_date / cinema_time /
//                                     cinema_name.
//
// The watched_in_cinema flag itself is toggled through PATCH /api/media/:id
// (same pattern as `owned`); these routes cover the ticket list and its metadata.

import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { readMetaSync } from '../cache.js';
import { DATA_DIR } from '../config.js';

// User-editable list of cinema names. One name per line; blank lines and lines
// starting with '#' (comments) are ignored. Edit this file to change the options
// shown in each ticket's "Cinema" selector — no restart needed (read per request).
// When the file is absent or has no names, the client falls back to a free-text
// input instead of a dropdown.
const CINEMAS_FILE = path.join(DATA_DIR, 'cinemas.txt');

function readCinemas() {
  try {
    const raw = fs.readFileSync(CINEMAS_FILE, 'utf8');
    const seen = new Set();
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const name = line.trim();
      if (!name || name.startsWith('#')) continue; // blank / comment
      if (seen.has(name)) continue; // de-dupe, keep first occurrence
      seen.add(name);
      out.push(name);
    }
    return out;
  } catch {
    return []; // missing / unreadable → free-text fallback on the client
  }
}

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const ticketsStmt = db.prepare(
  `SELECT id, tmdb_id, title_it, cinema_date, cinema_time, cinema_name
     FROM items
    WHERE type = 'movie' AND watched_in_cinema = 1
    ORDER BY (cinema_date IS NULL), cinema_date DESC, id DESC`
);
const getMovieStmt = db.prepare("SELECT id, type FROM items WHERE id = ?");

// Accept only real 'YYYY-MM-DD' dates and 'HH:MM' times (or empty → cleared).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CINEMA_NAME_MAX = 80; // trim overly long free-text entries

export default async function cinemaRoutes(fastify) {
  // GET /api/cinema/tickets → the ticket collection (newest screening first;
  // undated tickets last). Backdrops come from the existing local TMDB cache.
  fastify.get('/api/cinema/tickets', async () => {
    const rows = ticketsStmt.all();
    return {
      tickets: rows.map((r) => {
        // Release date (from the cached meta) is the default shown when the user
        // hasn't set a cinema date. Read-only; never triggers a network fetch.
        const meta = readMetaSync('movie', r.tmdb_id);
        return {
          id: r.id,
          tmdb_id: r.tmdb_id,
          title: r.title_it,
          backdrop_url: `/assets/movies/${r.tmdb_id}/backdrop.webp`,
          cinema_date: r.cinema_date || null,
          cinema_time: r.cinema_time || null,
          cinema_name: r.cinema_name || null,
          release_date: (meta && meta.release_date) || null,
        };
      }),
    };
  });

  // GET /api/cinema/list → the configurable cinema names (from data/cinemas.txt)
  // used to populate the ticket's cinema-name selector. Empty when unconfigured.
  fastify.get('/api/cinema/list', async () => {
    return { cinemas: readCinemas() };
  });

  // PATCH /api/movies/:id/cinema  { cinema_date?, cinema_time? }
  // Each field is optional; a null/empty value clears it. Saved immediately by
  // the ticket UI (optimistic on the client), so validation is strict here.
  fastify.patch('/api/movies/:id/cinema', async (request, reply) => {
    const row = getMovieStmt.get(request.params.id);
    if (!row || row.type !== 'movie') {
      reply.code(404);
      return { error: 'not found' };
    }
    const body = request.body || {};
    const fields = [];
    const params = [];

    if (body.cinema_date !== undefined) {
      const v = body.cinema_date;
      if (v !== null && v !== '' && !DATE_RE.test(String(v))) {
        reply.code(400);
        return { error: 'cinema_date must be YYYY-MM-DD or null' };
      }
      fields.push('cinema_date = ?');
      params.push(v ? String(v) : null);
    }
    if (body.cinema_time !== undefined) {
      const v = body.cinema_time;
      if (v !== null && v !== '' && !TIME_RE.test(String(v))) {
        reply.code(400);
        return { error: 'cinema_time must be HH:MM or null' };
      }
      fields.push('cinema_time = ?');
      params.push(v ? String(v) : null);
    }
    if (body.cinema_name !== undefined) {
      const v = body.cinema_name;
      // Free text (dropdown value or typed name); empty/null clears it.
      const name = v == null ? null : String(v).trim().slice(0, CINEMA_NAME_MAX);
      fields.push('cinema_name = ?');
      params.push(name || null);
    }

    if (!fields.length) return { ok: true };

    db.prepare(`UPDATE items SET ${fields.join(', ')} WHERE id = ?`).run(...params, row.id);
    return { ok: true };
  });
}
