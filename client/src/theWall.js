// "The Wall" — a home section styled as a real wall: your one favourite film and
// series taped up either side of a framed portrait of your favourite person.
//
// Everything decorative here is INLINE SVG (scotch tape, the ornate frame) so
// there are no extra image assets to ship or cache. Posters come from the local
// TMDB cache; the person photo comes from /api/persons/:id/photo (custom upload
// first, then the cached TMDB profile).
//
// The glossy sheen on the two posters reuses the owned-poster reflection from
// styles.css rather than redefining it — see the `.detail-poster::after` rule,
// whose selector list includes .wall-poster.

import { api } from './api.js';
import { openDetail, navigate } from './router.js';
import { el, toast } from './ui.js';
import { withBase } from './basePath.js';
import { openTitlePicker, openPersonPicker } from './pickers.js';
import { saveWall, getWall } from './offlineCache.js';
import { t } from './i18n.js';

// Two strips of coloured tape, rotated across opposite corners — the same soft
// rounded strip as before, with the diagonal hatch for adhesive grain and the
// blur filter softening the edges.
//
// What changed is the paint. It used to be a 62%-alpha cream wash with a white
// hatch over it, which on a near-black wall composited down to a grey smudge;
// both are OPAQUE colours now. One roll per poster, so the film and the series
// are taped up in different colours: a warm clementine and a muted sage, dialled
// down from the palette so they sit on the wall rather than shout off it.
const TAPES = {
  movie: { face: '#c85f36', grain: '#d97e57' },
  show: { face: '#4a7359', grain: '#6b9578' },
};

function tape(corner, kind) {
  const c = TAPES[kind] || TAPES.movie;
  const id = `tapeGrain-${kind}-${corner}`;
  return `
<svg class="wall-tape wall-tape--${corner}" viewBox="0 0 78 30" aria-hidden="true">
  <defs>
    <pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="${c.grain}" stroke-width="1.1"/>
    </pattern>
    <filter id="${id}-soft" x="-10%" y="-25%" width="120%" height="150%">
      <feGaussianBlur stdDeviation="0.5"/>
    </filter>
  </defs>
  <g filter="url(#${id}-soft)">
    <rect x="1" y="6" width="76" height="18" rx="1" fill="${c.face}"/>
    <rect x="1" y="6" width="76" height="18" rx="1" fill="url(#${id})"/>
  </g>
</svg>`;
}

// Carved wooden picture frame, in the style of a classic moulding: concentric
// bevel bands in warm wood gradients — outer lip, lit bevel, wide moulding,
// carved groove, inner bevel — rather than flat drawn lines.
//
// Each band is an even-odd ring (outer rect minus inner rect), so the middle
// stays transparent and the photo shows through. Insets are slightly larger
// vertically than horizontally, matching the photo box's own margin, so the
// moulding reads a touch thicker top and bottom. Drawn on a portrait 300x400
// canvas — the same 3:4 as the box, so nothing distorts.
//
// LIGHT COMES FROM THE TOP-LEFT, and every gradient runs monotonically from lit
// to shadowed along that diagonal — the outward-facing bands from top-left, the
// inner bevel from the opposite corner because it faces back into the picture.
// The old gradients travelled light -> dark -> light -> dark across a single
// diagonal, which at the frame's real width (about 8px on a phone) averaged out
// to a flat brown smear instead of a moulding with a lit side and a shaded one.
function ornateFrame() {
  // Ring from an outer inset (ox, oy) to an inner inset (ix, iy).
  const ring = (ox, oy, ix, iy, fill) =>
    `<path fill="${fill}" fill-rule="evenodd" d="M${ox} ${oy}H${300 - ox}V${400 - oy}H${ox}Z` +
    `M${ix} ${iy}V${400 - iy}H${300 - ix}V${iy}Z"/>`;

  return `
<svg class="wall-frame-svg" viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <linearGradient id="wfMain" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d09b6f"/>
      <stop offset=".45" stop-color="#a9663a"/>
      <stop offset="1" stop-color="#6d3d1d"/>
    </linearGradient>
    <linearGradient id="wfBevel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f0cda6"/>
      <stop offset=".5" stop-color="#c48f63"/>
      <stop offset="1" stop-color="#7d4320"/>
    </linearGradient>
    <linearGradient id="wfInner" x1="1" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#e0b489"/>
      <stop offset=".55" stop-color="#ab6a3f"/>
      <stop offset="1" stop-color="#673617"/>
    </linearGradient>
  </defs>
  ${ring(0, 0, 3.5, 4.5, '#48250f')}
  ${ring(3.5, 4.5, 8.5, 11.5, 'url(#wfBevel)')}
  ${ring(8.5, 11.5, 16.5, 22.5, 'url(#wfMain)')}
  ${ring(16.5, 22.5, 19.5, 27, '#5a2f16')}
  ${ring(19.5, 27, 25, 34.5, 'url(#wfInner)')}
  ${ring(25, 34.5, 26.5, 36.5, '#32180a')}
</svg>`;
}

// --- Offline copy ----------------------------------------------------------
// The Wall's pictures are served from /assets and /api, neither of which the
// service worker keeps, so an offline visit would show three empty slots. Since
// there are only ever three of them, we inline them as data URLs in the offline
// cache alongside the favourites payload.

// Anything much larger than this is not worth the localStorage budget; the slot
// simply falls back to its normal URL (fine online, empty offline).
const MAX_CACHED_IMG_BYTES = 400 * 1024;

// data: URLs come back from the offline copy and must be used verbatim;
// everything else is an app path that still needs the base prefix.
const imgSrc = (u) => (typeof u === 'string' && u.startsWith('data:') ? u : withBase(u));

// Read a blob as a data: URL (verbatim bytes). null on failure.
function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}

// Downscale an image blob through a canvas and re-encode it compactly. A custom
// person upload is stored at full size (unlike posters, which are recompressed to
// a small WebP), so it can be several hundred KB to multiple MB — too big to inline
// verbatim. The Wall paints this in a small framed portrait, so a 400px long edge
// is ample. null if the image can't be decoded or drawn.
async function downscaleToDataUrl(blob, maxDim = 400, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close?.();
      return null;
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    // Prefer WebP; browsers without WebP canvas encoding return PNG, which bloats a
    // photo, so fall back to JPEG in that case.
    const webp = canvas.toDataURL('image/webp', quality);
    return webp && webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
}

// Fetch one image through the normal same-origin (authenticated) path and encode
// it as a data URL for the offline copy. Small images are inlined verbatim; one
// larger than the store budget is downscaled first so it still fits (rather than
// being dropped, which left the person slot blank offline). null on any failure —
// caching is entirely best-effort.
async function toDataUrl(url) {
  try {
    const res = await fetch(withBase(url), { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
    if (blob.size <= MAX_CACHED_IMG_BYTES) return await blobToDataUrl(blob);
    return await downscaleToDataUrl(blob);
  } catch {
    return null;
  }
}

// Keep only what the section paints (and what a click needs to navigate).
async function cacheWall(fav) {
  try {
    const [moviePic, showPic, personPic] = await Promise.all([
      fav.movie ? toDataUrl(fav.movie.poster_url) : null,
      fav.show ? toDataUrl(fav.show.poster_url) : null,
      fav.person
        ? toDataUrl(fav.person.photo_url || `/api/persons/${fav.person.tmdb_id}/photo`)
        : null,
    ]);
    saveWall({
      movie: fav.movie
        ? { id: fav.movie.id, title: fav.movie.title, poster_url: moviePic || fav.movie.poster_url }
        : null,
      show: fav.show
        ? { id: fav.show.id, title: fav.show.title, poster_url: showPic || fav.show.poster_url }
        : null,
      person: fav.person
        ? { tmdb_id: fav.person.tmdb_id, name: fav.person.name, photo_url: personPic || null }
        : null,
    });
  } catch {
    /* quota / disabled store — the wall just won't be there offline */
  }
}

function placeholder(label) {
  return el('div', { class: 'wall-empty' }, [
    el('span', { class: 'wall-empty-plus', text: '+' }),
    el('span', { class: 'wall-empty-label', text: label }),
  ]);
}

// One taped-up poster (movie or show). `data` is null when nothing is pinned.
function posterSlot(kind, data, { onOpen, onPick }) {
  const inner = el('div', { class: 'wall-poster' });
  if (data) {
    inner.append(
      el('img', {
        class: 'wall-poster-img',
        src: imgSrc(data.poster_url),
        alt: data.title || '',
        loading: 'lazy',
      })
    );
  } else {
    inner.append(placeholder(kind === 'movie' ? t('wall.setFilm') : t('wall.setSeries')));
    inner.classList.add('is-empty');
  }
  const slot = el('div', { class: `wall-slot wall-slot--${kind}` }, [inner]);
  // Tape sits above the poster, straddling two opposite corners.
  slot.insertAdjacentHTML('beforeend', tape('tl', kind));
  slot.insertAdjacentHTML('beforeend', tape('br', kind));
  slot.addEventListener('click', () => (data ? onOpen(data) : onPick()));
  return slot;
}

function personSlot(person, { onOpen, onPick, fallbackSrc }) {
  const photo = person
    ? el('img', {
        class: 'wall-person-img',
        src: imgSrc(person.photo_url || `/api/persons/${person.tmdb_id}/photo`),
        alt: person.name || '',
        loading: 'lazy',
      })
    : placeholder(t('wall.setPerson'));
  // If the live photo fails to load (offline, a transient blip, or no TMDB image),
  // try the stored offline copy first so a good picture isn't dropped for a
  // silhouette over a momentary hiccup. Only when there's no usable copy at all do
  // we settle on the silhouette, and never loop back onto a src that just failed.
  if (person) {
    photo.addEventListener('error', () => {
      if (fallbackSrc && photo.getAttribute('src') !== fallbackSrc) {
        photo.src = fallbackSrc;
        return;
      }
      photo.replaceWith(el('div', { class: 'wall-person-silhouette' }));
    });
  }
  const box = el('div', { class: 'wall-person-photo' + (person ? '' : ' is-empty') }, [photo]);
  const slot = el('div', { class: 'wall-slot wall-slot--person' }, [box]);
  slot.insertAdjacentHTML('beforeend', ornateFrame());
  slot.addEventListener('click', () => (person ? onOpen(person) : onPick()));
  return slot;
}

// Build the section. Returns the element; it refreshes itself after any pick.
export function createTheWall() {
  const row = el('div', { class: 'wall-row' });
  const section = el('section', { class: 'wall-section' }, [
    el('h3', { class: 'section-title', text: t('wall.title') }),
    row,
  ]);

  async function pickTitle(kind) {
    openTitlePicker({
      type: kind,
      onPick: async (item) => {
        try {
          await (kind === 'movie'
            ? api.setFavoriteMovie(item.tmdb_id)
            : api.setFavoriteShow(item.tmdb_id));
          render();
        } catch (err) {
          toast(err.message || t('wall.setFavoriteFailed'), 'bad');
        }
      },
    });
  }
  function pickPerson() {
    openPersonPicker({
      onPick: async (p) => {
        try {
          await api.setFavoritePerson(p.tmdb_id);
          render();
        } catch (err) {
          toast(err.message || t('wall.setPersonFailed'), 'bad');
        }
      },
    });
  }

  // Repaint the three slots from a favourites payload — live, or the offline copy.
  // `fallback` is the previously stored copy (data URLs); the person photo falls
  // back to it if the live one fails to load.
  function paint(fav, fallback) {
    row.innerHTML = '';
    const personFallback =
      fallback && fallback.person && typeof fallback.person.photo_url === 'string'
        ? imgSrc(fallback.person.photo_url)
        : null;
    row.append(
      posterSlot('movie', fav.movie, {
        onOpen: (d) => openDetail(`/detail/${d.id}`),
        onPick: () => pickTitle('movie'),
      }),
      personSlot(fav.person, {
        onOpen: (p) => navigate(`/person/${p.tmdb_id}`),
        onPick: pickPerson,
        fallbackSrc: personFallback,
      }),
      posterSlot('show', fav.show, {
        onOpen: (d) => openDetail(`/detail/${d.id}`),
        onPick: () => pickTitle('show'),
      })
    );
  }

  async function render() {
    // Paint the stored copy first: the wall appears instantly, and it is all we
    // get when offline. The live payload replaces it as soon as it lands.
    const cached = getWall();
    if (cached) paint(cached);
    let fav;
    try {
      fav = await api.favorites();
    } catch {
      // Offline / error → keep the cached wall, or show the empty one.
      if (!cached) paint({ movie: null, show: null, person: null });
      return;
    }
    paint(fav, cached);
    cacheWall(fav);
  }

  render();
  return section;
}
