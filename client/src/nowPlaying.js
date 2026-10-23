// Kodi "Now Playing" UI:
//   • a small header indicator ("Now Playing") — tap to open the toast
//   • the animated wavy avatar ring
//   • a top-sliding toast (poster · title/episode/tracks), read-only: it shows
//     only what Kodi reports as playing, with no library actions
// Everything reads the cached snapshot from kodi.js (getNowPlaying) and updates
// on the shared `shelfit:kodi-nowplaying` event. Both the header indicator and
// the profile avatar open the SAME toast; when nothing is playing they do
// nothing. The toast never fetches on tap.

import { el, cachedImg } from './ui.js';
import { getNowPlaying } from './kodi.js';
import { createWavyRing } from './wavyRing.js';
import { t, onLangChange } from './i18n.js';

const KODI_BLUE = '#17B2E8';
const PLAY = // filled play glyph (inlined so it renders solid, no mask/caching)
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>';

// --- Module state ---------------------------------------------------------
let indicator = null;
let toastEl = null;
let els = {}; // cached toast sub-elements
let toastOpen = false;
let currentRing = null; // ring attached to the currently-mounted avatar (or null)
let currentWrap = null; // the .avatar-wrap element hosting the ring (or null)
let autoCloseTimer = null; // dismisses an open toast after a short peek

// The toast is a quick glance at what's playing — auto-dismiss it a few seconds
// after it opens so it never lingers over the UI.
const TOAST_AUTO_CLOSE_MS = 5000;

// --- Build (indicator + toast, once) --------------------------------------
export function initNowPlaying(headerActionsEl) {
  if (indicator) return;

  // Header indicator: a pulsing "play" glyph + "Now Playing", tappable. Space is
  // always reserved (visibility toggled) so nothing shifts on appear/disappear.
  indicator = el('button', {
    class: 'np-indicator',
    'aria-label': t('nowPlaying.indicatorAria'),
    onClick: (e) => {
      e.stopPropagation();
      toggleToast();
    },
  });
  const glyph = el('span', { class: 'np-audio' });
  glyph.innerHTML = PLAY;
  indicator.append(glyph, el('span', { class: 'np-indicator-label' }, [t('nowPlaying.label')]));
  if (headerActionsEl) headerActionsEl.prepend(indicator);

  // Toast (built once, reused): [poster] [ title / SxxExx / tracks ].
  const poster = el('div', { class: 'np-toast-poster' });
  const title = el('div', { class: 'np-toast-title' });
  const meta = el('div', { class: 'np-toast-meta' });
  const tracks = el('div', { class: 'np-toast-tracks' });
  const text = el('div', { class: 'np-toast-text' }, [title, meta, tracks]);
  const body = el('div', { class: 'np-toast-body' }, [text]);
  toastEl = el('div', { class: 'np-toast', role: 'dialog', 'aria-label': t('nowPlaying.label') }, [
    poster,
    body,
  ]);
  document.body.appendChild(toastEl);
  els = { poster, title, meta, tracks };

  // Outside-tap dismiss.
  document.addEventListener('click', (e) => {
    if (
      toastOpen &&
      !toastEl.contains(e.target) &&
      e.target !== indicator &&
      !indicator.contains(e.target) &&
      !(currentWrap && currentWrap.contains(e.target))
    ) {
      closeToast();
    }
  });

  window.addEventListener('shelfit:kodi-nowplaying', (e) => render(e.detail || getNowPlaying()));
  // The indicator and toast outlive page renders — relabel them on a language switch.
  onLangChange(() => {
    indicator.setAttribute('aria-label', t('nowPlaying.indicatorAria'));
    indicator.querySelector('.np-indicator-label').textContent = t('nowPlaying.label');
    toastEl.setAttribute('aria-label', t('nowPlaying.label'));
    if (toastOpen) fillToast(getNowPlaying());
  });
  render(getNowPlaying());
}

// --- Avatar ring + tap trigger (Home calls this on mount) -----------------
export function attachNowPlayingRing(wrapEl) {
  if (!wrapEl) return;
  const ring = createWavyRing({ color: KODI_BLUE });
  wrapEl.appendChild(ring.el);
  currentRing = ring;
  currentWrap = wrapEl;
  // Tapping the avatar opens the same toast (only while something is playing).
  wrapEl.addEventListener('click', (e) => {
    if (!(getNowPlaying() || {}).active) return; // idle → do nothing
    e.stopPropagation();
    toggleToast();
  });
  applyRing(getNowPlaying());
}

// Home calls this on teardown. Without it, currentRing / currentWrap keep the
// previous Home's avatar subtree (SVG ring included) alive as detached DOM for
// as long as the user stays on another page.
export function detachNowPlayingRing(wrapEl) {
  if (wrapEl && currentWrap !== wrapEl) return; // a newer Home already took over
  if (currentRing) currentRing.setActive(false); // stops its rAF loop immediately
  currentRing = null;
  currentWrap = null;
}

function applyRing(np) {
  if (!currentRing) return;
  const active = !!(np && np.active);
  // `.playing` → the avatar becomes a Now-Playing trigger; drives the ring too.
  if (currentWrap) currentWrap.classList.toggle('playing', active);
  currentRing.setActive(active);
  if (active) currentRing.setProgress(progressFraction(np));
}

function progressFraction(np) {
  if (!np) return 0;
  if (np.total_seconds > 0) return np.time_seconds / np.total_seconds;
  return (np.percentage || 0) / 100;
}

// A stable key per playing item so the proxied Kodi poster is browser-cached
// within one title but refetched when the item changes.
function posterKey(np) {
  return [np.tmdb_id || '', np.show_title || np.title || '', np.season || '', np.episode || ''].join(
    '|'
  );
}

// --- Render (indicator + ring + live toast content) -----------------------
function render(np) {
  const active = !!(np && np.active);
  if (indicator) indicator.classList.toggle('active', active);
  applyRing(np);

  if (toastOpen) {
    if (!active) closeToast();
    else fillToast(np); // keep an open toast in sync
  }
}

// --- Toast content --------------------------------------------------------
function fillToast(np) {
  const isEp = np.media_type === 'episode';

  // Poster: local shelfIt TMDB cache first (matched titles); otherwise Kodi's own
  // artwork, proxied through the server; skeleton when neither is available.
  // `_src` guards against rebuilding (and re-fetching) on every poll while open.
  let posterSrc = null;
  if (np.match && np.match.poster_url) posterSrc = np.match.poster_url;
  else if (np.kodi_poster)
    posterSrc = `/api/kodi/now-playing/poster?k=${encodeURIComponent(posterKey(np))}`;

  if (posterSrc !== els.poster._src) {
    els.poster._src = posterSrc;
    els.poster.innerHTML = '';
    if (posterSrc) {
      els.poster.classList.remove('skeleton');
      const img = cachedImg(posterSrc, { alt: '' });
      img.addEventListener('error', () => {
        if (img.parentNode) img.remove();
        els.poster.classList.add('skeleton');
        els.poster._src = null; // allow a later retry
      });
      els.poster.appendChild(img);
    } else {
      els.poster.classList.add('skeleton');
    }
  }

  // Title + season/episode (under the title) or year for a movie.
  els.title.textContent = isEp ? np.show_title || t('nowPlaying.fallbackTitle') : np.title || t('nowPlaying.fallbackTitle');
  let metaText = '';
  if (isEp) {
    if (np.season > 0)
      metaText = `S${String(np.season).padStart(2, '0')} · E${String(np.episode || 0).padStart(2, '0')}`;
    else if (np.episode > 0) metaText = t('nowPlaying.episode', { episode: np.episode });
  } else if (np.year) {
    metaText = String(np.year);
  }
  // Drop the meta line when it would just repeat the heading (e.g. a bare
  // "Episode 7" with no show/season resolved).
  if (metaText && metaText === els.title.textContent) metaText = '';
  els.meta.textContent = metaText;
  els.meta.style.display = metaText ? '' : 'none';

  // Audio / subtitle ISO-639-1 codes on one compact line.
  const audio = (np.audio && np.audio.language) || '—';
  const sub = (np.subtitle && np.subtitle.language) || '—';
  els.tracks.innerHTML = `${audio}<span class="sep">·</span>${t('nowPlaying.subtitles', { lang: sub })}`;
}

// --- Open / close ---------------------------------------------------------
function toggleToast() {
  if (toastOpen) closeToast();
  else openToast();
}
function openToast() {
  const np = getNowPlaying();
  if (!toastEl || !(np && np.active) || overlayOpen()) return; // idle / behind a modal → nothing
  fillToast(np);
  // Settle just below the header (measured live, so safe-area insets are honoured).
  const header = document.querySelector('.app-header');
  const top = header ? header.getBoundingClientRect().bottom + 8 : 72;
  toastEl.style.top = `${Math.round(top)}px`;
  toastEl.classList.remove('dismissing');
  requestAnimationFrame(() => toastEl.classList.add('show'));
  toastOpen = true;
  // Auto-dismiss after a brief peek.
  clearTimeout(autoCloseTimer);
  autoCloseTimer = setTimeout(closeToast, TOAST_AUTO_CLOSE_MS);
}
function closeToast() {
  if (!toastEl) return;
  clearTimeout(autoCloseTimer);
  autoCloseTimer = null;
  toastEl.classList.add('dismissing');
  toastEl.classList.remove('show');
  toastOpen = false;
}

// Never overlap an open modal / bottom sheet.
function overlayOpen() {
  return !!document.querySelector('.modal-backdrop');
}
