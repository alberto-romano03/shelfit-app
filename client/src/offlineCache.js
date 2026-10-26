// Durable, timestamped offline datasets (localStorage) for the two views that
// stay useful without a server connection:
//   • Plan to Watch — a trimmed detail per planned title, so its detail page
//     opens (read-only) offline.
//   • Up Next       — the next-episode-to-watch cards, so you know what to start.
//
// Design:
//   • One localStorage entry per dataset, replaced in full on the next sync, with
//     a sibling `:m` meta entry holding the sync timestamp (+ a compressed flag).
//   • Size is kept down first by storing ONLY the strictly-necessary fields (the
//     callers trim before handing data here), then — only when a serialized
//     dataset actually exceeds a threshold — by a lightweight vanilla LZ codec
//     (UTF-16, no dependencies). Small datasets stay raw JSON for simplicity.
//   • Everything is best-effort: a disabled store (private mode), a full quota, or
//     malformed data all fail silently and the app behaves exactly as before.
//
// Image data is normally NOT stored here — the datasets keep string poster paths
// that reference the existing on-device image cache. The one exception is The
// Wall: it shows exactly three pictures, and they must be visible offline, so
// those (and only those) are inlined as data URLs.

import { pset, planKey } from './persist.js';
import { locale } from './i18n.js';
import { userPrefix } from './userScope.js';

// Datasets live under the signed-in member's prefix (`shelfit:u<id>:oc:`), so a
// shared device keeps each member's offline copies apart; null when no member is
// known, which turns every read into a miss and every write into a no-op.
function ocPrefix() {
  const prefix = userPrefix();
  return prefix ? `${prefix}oc:` : null;
}

// Serialize→store raw below this many characters; compress at/above it. Measured
// on real datasets, a typical Plan-to-Watch/Up-Next payload is a few KB and fits
// comfortably raw; compression only earns its keep once the list grows large.
const COMPRESS_MIN = 4096;

// Dataset keys.
export const OC = {
  planDetails: 'plan-details', // { [itemId]: <trimmed detail> }
  upNext: 'up-next', // [ <watch_next entry>, … ]
  upcoming: 'upcoming', // { horizon, watch_next, upcoming } — the whole What's Next payload
  wall: 'wall', // { movie, show, person } — The Wall, images inlined as data URLs
};

// How long a cached What's Next payload is trusted offline. The "On the Horizon"
// countdowns are recomputed client-side from each episode's absolute air_date, so
// a copy stays correct as long as the schedule itself hasn't changed — which is
// very unlikely within a day. 12h keeps the horizon visible offline without ever
// showing a schedule that could be a day or more out of date.
export const UPCOMING_TTL_MS = 12 * 60 * 60 * 1000;

// --- Lightweight LZ (UTF-16) ----------------------------------------------
// Trimmed from pieroxy/lz-string 1.4.4 (compressToUTF16 / decompressFromUTF16),
// the two codecs we use. Public domain (WTFPL). Round-trips arbitrary JSON to a
// compact UTF-16 string that localStorage stores verbatim.
const f = String.fromCharCode;

function _compress(uncompressed, bitsPerChar, getCharFromInt) {
  if (uncompressed == null) return '';
  let i,
    value,
    context_dictionary = {},
    context_dictionaryToCreate = {},
    context_c = '',
    context_wc = '',
    context_w = '',
    context_enlargeIn = 2,
    context_dictSize = 3,
    context_numBits = 2,
    context_data = [],
    context_data_val = 0,
    context_data_position = 0,
    ii;

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  for (ii = 0; ii < uncompressed.length; ii += 1) {
    context_c = uncompressed.charAt(ii);
    if (!has(context_dictionary, context_c)) {
      context_dictionary[context_c] = context_dictSize++;
      context_dictionaryToCreate[context_c] = true;
    }
    context_wc = context_w + context_c;
    if (has(context_dictionary, context_wc)) {
      context_w = context_wc;
    } else {
      if (has(context_dictionaryToCreate, context_w)) {
        if (context_w.charCodeAt(0) < 256) {
          for (i = 0; i < context_numBits; i++) {
            context_data_val = context_data_val << 1;
            if (context_data_position == bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else {
              context_data_position++;
            }
          }
          value = context_w.charCodeAt(0);
          for (i = 0; i < 8; i++) {
            context_data_val = (context_data_val << 1) | (value & 1);
            if (context_data_position == bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else {
              context_data_position++;
            }
            value = value >> 1;
          }
        } else {
          value = 1;
          for (i = 0; i < context_numBits; i++) {
            context_data_val = (context_data_val << 1) | value;
            if (context_data_position == bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else {
              context_data_position++;
            }
            value = 0;
          }
          value = context_w.charCodeAt(0);
          for (i = 0; i < 16; i++) {
            context_data_val = (context_data_val << 1) | (value & 1);
            if (context_data_position == bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else {
              context_data_position++;
            }
            value = value >> 1;
          }
        }
        context_enlargeIn--;
        if (context_enlargeIn == 0) {
          context_enlargeIn = Math.pow(2, context_numBits);
          context_numBits++;
        }
        delete context_dictionaryToCreate[context_w];
      } else {
        value = context_dictionary[context_w];
        for (i = 0; i < context_numBits; i++) {
          context_data_val = (context_data_val << 1) | (value & 1);
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
          value = value >> 1;
        }
      }
      context_enlargeIn--;
      if (context_enlargeIn == 0) {
        context_enlargeIn = Math.pow(2, context_numBits);
        context_numBits++;
      }
      context_dictionary[context_wc] = context_dictSize++;
      context_w = String(context_c);
    }
  }

  if (context_w !== '') {
    if (has(context_dictionaryToCreate, context_w)) {
      if (context_w.charCodeAt(0) < 256) {
        for (i = 0; i < context_numBits; i++) {
          context_data_val = context_data_val << 1;
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
        }
        value = context_w.charCodeAt(0);
        for (i = 0; i < 8; i++) {
          context_data_val = (context_data_val << 1) | (value & 1);
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
          value = value >> 1;
        }
      } else {
        value = 1;
        for (i = 0; i < context_numBits; i++) {
          context_data_val = (context_data_val << 1) | value;
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
          value = 0;
        }
        value = context_w.charCodeAt(0);
        for (i = 0; i < 16; i++) {
          context_data_val = (context_data_val << 1) | (value & 1);
          if (context_data_position == bitsPerChar - 1) {
            context_data_position = 0;
            context_data.push(getCharFromInt(context_data_val));
            context_data_val = 0;
          } else {
            context_data_position++;
          }
          value = value >> 1;
        }
      }
      context_enlargeIn--;
      if (context_enlargeIn == 0) {
        context_enlargeIn = Math.pow(2, context_numBits);
        context_numBits++;
      }
      delete context_dictionaryToCreate[context_w];
    } else {
      value = context_dictionary[context_w];
      for (i = 0; i < context_numBits; i++) {
        context_data_val = (context_data_val << 1) | (value & 1);
        if (context_data_position == bitsPerChar - 1) {
          context_data_position = 0;
          context_data.push(getCharFromInt(context_data_val));
          context_data_val = 0;
        } else {
          context_data_position++;
        }
        value = value >> 1;
      }
    }
    context_enlargeIn--;
    if (context_enlargeIn == 0) {
      context_enlargeIn = Math.pow(2, context_numBits);
      context_numBits++;
    }
  }

  value = 2;
  for (i = 0; i < context_numBits; i++) {
    context_data_val = (context_data_val << 1) | (value & 1);
    if (context_data_position == bitsPerChar - 1) {
      context_data_position = 0;
      context_data.push(getCharFromInt(context_data_val));
      context_data_val = 0;
    } else {
      context_data_position++;
    }
    value = value >> 1;
  }

  while (true) {
    context_data_val = context_data_val << 1;
    if (context_data_position == bitsPerChar - 1) {
      context_data.push(getCharFromInt(context_data_val));
      break;
    } else context_data_position++;
  }
  return context_data.join('');
}

function _decompress(length, resetValue, getNextValue) {
  let dictionary = [],
    enlargeIn = 4,
    dictSize = 4,
    numBits = 3,
    entry = '',
    result = [],
    i,
    w,
    bits,
    resb,
    maxpower,
    power,
    c,
    data = { val: getNextValue(0), position: resetValue, index: 1 };

  for (i = 0; i < 3; i += 1) dictionary[i] = i;

  bits = 0;
  maxpower = Math.pow(2, 2);
  power = 1;
  while (power != maxpower) {
    resb = data.val & data.position;
    data.position >>= 1;
    if (data.position == 0) {
      data.position = resetValue;
      data.val = getNextValue(data.index++);
    }
    bits |= (resb > 0 ? 1 : 0) * power;
    power <<= 1;
  }

  switch (bits) {
    case 0:
      bits = 0;
      maxpower = Math.pow(2, 8);
      power = 1;
      while (power != maxpower) {
        resb = data.val & data.position;
        data.position >>= 1;
        if (data.position == 0) {
          data.position = resetValue;
          data.val = getNextValue(data.index++);
        }
        bits |= (resb > 0 ? 1 : 0) * power;
        power <<= 1;
      }
      c = f(bits);
      break;
    case 1:
      bits = 0;
      maxpower = Math.pow(2, 16);
      power = 1;
      while (power != maxpower) {
        resb = data.val & data.position;
        data.position >>= 1;
        if (data.position == 0) {
          data.position = resetValue;
          data.val = getNextValue(data.index++);
        }
        bits |= (resb > 0 ? 1 : 0) * power;
        power <<= 1;
      }
      c = f(bits);
      break;
    case 2:
      return '';
  }
  dictionary[3] = c;
  w = c;
  result.push(c);
  while (true) {
    if (data.index > length) return '';

    bits = 0;
    maxpower = Math.pow(2, numBits);
    power = 1;
    while (power != maxpower) {
      resb = data.val & data.position;
      data.position >>= 1;
      if (data.position == 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index++);
      }
      bits |= (resb > 0 ? 1 : 0) * power;
      power <<= 1;
    }

    switch ((c = bits)) {
      case 0:
        bits = 0;
        maxpower = Math.pow(2, 8);
        power = 1;
        while (power != maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position == 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb > 0 ? 1 : 0) * power;
          power <<= 1;
        }
        dictionary[dictSize++] = f(bits);
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        bits = 0;
        maxpower = Math.pow(2, 16);
        power = 1;
        while (power != maxpower) {
          resb = data.val & data.position;
          data.position >>= 1;
          if (data.position == 0) {
            data.position = resetValue;
            data.val = getNextValue(data.index++);
          }
          bits |= (resb > 0 ? 1 : 0) * power;
          power <<= 1;
        }
        dictionary[dictSize++] = f(bits);
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join('');
    }

    if (enlargeIn == 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }

    if (dictionary[c]) {
      entry = dictionary[c];
    } else {
      if (c === dictSize) {
        entry = w + w.charAt(0);
      } else {
        return null;
      }
    }
    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn == 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }
}

function compressToUTF16(input) {
  if (input == null) return '';
  return (
    _compress(input, 15, function (a) {
      return f(a + 32);
    }) + ' '
  );
}
function decompressFromUTF16(compressed) {
  if (compressed == null) return '';
  if (compressed == '') return null;
  return _decompress(compressed.length, 16384, function (index) {
    return compressed.charCodeAt(index) - 32;
  });
}

// --- Generic dataset store ------------------------------------------------
// Stores `data` under `key` with the current time, compressing only when the
// serialized payload is large. Returns true on a successful write.
export function ocSet(key, data, { compress = true } = {}) {
  const prefix = ocPrefix();
  if (!prefix) return false;
  try {
    const json = JSON.stringify(data);
    let payload = json;
    let compressed = 0;
    if (compress && json.length >= COMPRESS_MIN) {
      const packed = compressToUTF16(json);
      // Only keep the compressed form if it actually came out smaller.
      if (packed && packed.length < json.length) {
        payload = packed;
        compressed = 1;
      }
    }
    localStorage.setItem(prefix + key, payload);
    localStorage.setItem(prefix + key + ':m', JSON.stringify({ t: Date.now(), c: compressed }));
    return true;
  } catch {
    return false; // quota / disabled — best-effort
  }
}

// Returns { data, savedAt } or null when absent/unreadable.
export function ocGet(key) {
  const prefix = ocPrefix();
  if (!prefix) return null;
  try {
    const metaRaw = localStorage.getItem(prefix + key + ':m');
    if (metaRaw === null) return null;
    const meta = JSON.parse(metaRaw);
    const payload = localStorage.getItem(prefix + key);
    if (payload === null) return null;
    const json = meta && meta.c ? decompressFromUTF16(payload) : payload;
    if (json == null) return null;
    return { data: JSON.parse(json), savedAt: meta && meta.t ? meta.t : null };
  } catch {
    return null;
  }
}

export function ocRemove(key) {
  const prefix = ocPrefix();
  if (!prefix) return;
  try {
    localStorage.removeItem(prefix + key);
    localStorage.removeItem(prefix + key + ':m');
  } catch {
    /* ignore */
  }
}

// A compact "last synced" label, e.g. "Aug 24, 14:32". '' for a missing time.
export function formatSyncTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(locale(), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '';
  }
}

// --- Plan-to-Watch detail dataset -----------------------------------------
// Trim a full /api/media/:id payload to the minimal fields the detail page needs
// to render (read-only) offline. Deliberately omits the heavy/secondary data the
// offline use case doesn't need: episode lists, cast/crew, collection, similar
// titles, and backdrop/fanart imagery. Poster is kept as a PATH only.
export function trimPlanDetail(d) {
  const m = d.meta || {};
  return {
    id: d.id,
    tmdb_id: d.tmdb_id,
    type: d.type,
    title_it: d.title_it,
    title_orig: d.title_orig || '',
    status: d.status,
    rating: d.rating != null ? d.rating : null,
    favorite: !!d.favorite,
    owned: !!d.owned,
    watched_in_cinema: !!d.watched_in_cinema,
    notes: d.notes || '',
    rewatch_count: d.rewatch_count || 0,
    added_at: d.added_at || null,
    updated_at: d.updated_at || null,
    poster_url: d.poster_url,
    meta: {
      overview: m.overview || '',
      year: m.year || '',
      genres: Array.isArray(m.genres) ? m.genres : [],
      runtime: m.runtime || null,
      episode_run_time: Array.isArray(m.episode_run_time) ? m.episode_run_time : undefined,
      status: m.status || '',
    },
  };
}

// Upsert one planned title's trimmed detail into the dataset (called while online
// — from the grid warm and opportunistically when a plan title is opened). Takes
// a full /api/media/:id payload; trimming to the minimal fields happens here.
export function savePlanDetail(d) {
  if (!d || d.id == null) return;
  const entry = trimPlanDetail(d);
  const cur = ocGet(OC.planDetails);
  const map = (cur && cur.data) || {};
  map[String(entry.id)] = entry;
  ocSet(OC.planDetails, map);
}

// Read one planned title's cached detail: { data, savedAt } | null.
export function getPlanDetail(id) {
  const cur = ocGet(OC.planDetails);
  if (!cur || !cur.data) return null;
  const entry = cur.data[String(id)];
  if (!entry) return null;
  return { data: entry, savedAt: cur.savedAt };
}

// Drop cached details for titles no longer in Plan to Watch. `keepIds` is the
// current set/array of planned item ids (all types).
export function prunePlanDetails(keepIds) {
  const cur = ocGet(OC.planDetails);
  if (!cur || !cur.data) return;
  const keep = new Set((keepIds || []).map(String));
  let changed = false;
  const next = {};
  for (const k of Object.keys(cur.data)) {
    if (keep.has(k)) next[k] = cur.data[k];
    else changed = true;
  }
  if (changed) ocSet(OC.planDetails, next);
}

// --- Plan-to-Watch grid list (durable, per type) --------------------------
// Split a /api/plan-to-watch payload by type and persist each type's slim poster
// list to its own localStorage key (plan:movie / plan:show, via persist.js), so
// BOTH Movies and Series grids render their Plan-to-Watch posters offline after a
// single online fetch — with no service-worker dependency. Shared by the grid
// view (on visit) and the boot preloader (on every online app open).
export function savePlanTitles(titles) {
  const slim = (t) => ({ id: t.id, title: t.title, poster_url: t.poster_url, rating: t.rating });
  const byType = { movie: [], show: [] };
  for (const t of titles || []) if (byType[t.type]) byType[t.type].push(slim(t));
  pset(planKey('movie'), byType.movie);
  pset(planKey('show'), byType.show);
}

// --- Up Next dataset ------------------------------------------------------
// Store the "watch next" cards verbatim (small; each already carries only the
// fields the card renders — series/episode, progress, thumbnail path).
export function saveUpNext(watchNext) {
  ocSet(OC.upNext, Array.isArray(watchNext) ? watchNext : []);
}
export function getUpNext() {
  return ocGet(OC.upNext); // { data:[…], savedAt } | null
}

// --- Whole What's Next payload (durable, for the offline "On the Horizon") -----
// Stores the full /api/upcoming payload (horizon + watch_next + upcoming) so the
// What's Next view — including the "On the Horizon" railway — renders offline. The
// countdown labels are recomputed from each air_date at render time, so the cached
// copy stays correct as the day passes. Kept slim by storing only the three arrays
// the view consumes (each already carries just the fields the cards render).
export function saveUpcoming(data) {
  ocSet(OC.upcoming, {
    horizon: (data && data.horizon) || [],
    watch_next: (data && data.watch_next) || [],
    upcoming: (data && data.upcoming) || [],
  });
}
// Returns { data, savedAt, fresh } or null. `fresh` is false once the copy is
// older than the TTL (see UPCOMING_TTL_MS): the air-date schedule may have moved
// on, so the caller should not show the horizon from a stale copy.
export function getUpcoming(maxAgeMs = UPCOMING_TTL_MS) {
  const cur = ocGet(OC.upcoming);
  if (!cur) return null;
  const fresh = cur.savedAt != null && Date.now() - cur.savedAt <= maxAgeMs;
  return { data: cur.data, savedAt: cur.savedAt, fresh };
}

// --- The Wall -------------------------------------------------------------
// The Wall's three slots with their artwork inlined as data URLs, so the section
// renders in full while offline (those images live outside the shell cache and
// can't be fetched). Compression is skipped: the payload is mostly base64, which
// the LZ codec can't shrink meaningfully and would only cost CPU.
export function saveWall(wall) {
  return ocSet(OC.wall, wall, { compress: false });
}

export function getWall() {
  const cur = ocGet(OC.wall);
  return cur ? cur.data : null;
}
