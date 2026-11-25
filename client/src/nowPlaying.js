// Kodi "Now Playing" UI:
//   • a small header indicator, a deck's lit LCD reading PLAYING (or PAUSE),
//     its play mark blinking: tap to open the toast
//   • the animated wavy avatar ring
//   • a top-sliding toast (poster · Kodi instance · title · episode · audio and
//     subtitle chips) with one action row under it: record what is playing in
//     the library (nowPlayingActions.js)
// Everything reads the cached snapshot from kodi.js (getNowPlaying) and updates
// on the shared `shelfit:kodi-nowplaying` event. Both the header indicator and
// the profile avatar open the SAME toast; when nothing is playing they do
// nothing. The toast never fetches on tap.

import { el, cachedImg, lucideIcon } from './ui.js';
import { getNowPlaying } from './kodi.js';
import { createWavyRing } from './wavyRing.js';
import { t, onLangChange } from './i18n.js';
import { fillActions } from './nowPlayingActions.js';
import { loadLcdFont, LCD_ALL_SEGMENTS } from './lcdFont.js';

const KODI_BLUE = '#17B2E8';

// --- The header's screen ---------------------------------------------------
// A small backlit LCD, its glass lit Kodi blue, the word in dark 14-segment
// characters: PLAYING, or PAUSE while Kodi is paused. The word stands still and
// the screen keeps one width; only the mark beside it (▶, or ‖) goes on and off,
// as a VCR's on-screen display does (CSS). The mark is drawn soft, not crisp:
// slightly blurred, its edges uneven, a faint smear to the right, like a picture
// off tape. The unlit segments show faintly behind the word.
// The softening, used by both marks (one indicator, so one id).
const LCD_SOFT =
  '<filter id="np-mark-soft" x="-60%" y="-60%" width="220%" height="220%">' +
  '<feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="1" seed="3" result="n"/>' +
  '<feDisplacementMap in="SourceGraphic" in2="n" scale="0.7" result="w"/>' +
  '<feGaussianBlur in="w" stdDeviation="0.45" result="b"/>' +
  '<feOffset in="b" dx="0.9" result="s"/>' +
  '<feColorMatrix in="s" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .35 0" result="sf"/>' +
  '<feGaussianBlur in="b" stdDeviation="1.4" result="halo"/>' +
  '<feMerge><feMergeNode in="halo"/><feMergeNode in="sf"/><feMergeNode in="b"/></feMerge></filter>';
const LCD_PLAY =
  '<svg viewBox="0 0 9 11" aria-hidden="true"><g filter="url(#np-mark-soft)">' +
  '<path d="M1.2.9C1 .7.7.8.7 1.2v8.6c0 .4.3.5.6.3l6.9-4.2c.3-.2.3-.6 0-.8Z"/></g></svg>';
const LCD_PAUSE =
  '<svg viewBox="0 0 9 11" aria-hidden="true"><g filter="url(#np-mark-soft)">' +
  '<rect x=".9" y=".8" width="2.6" height="9.4" rx=".4"/><rect x="5.5" y=".8" width="2.6" height="9.4" rx=".4"/></g></svg>';

// --- Module state ---------------------------------------------------------
let indicator = null;
let toastEl = null;
let scrim = null; // the dim behind the open toast, which takes taps outside it
let els = {}; // cached toast sub-elements
let toastOpen = false;
let currentRing = null; // ring attached to the currently-mounted avatar (or null)
let currentWrap = null; // the .avatar-wrap element hosting the ring (or null)
let autoCloseTimer = null; // dismisses an open toast after a short peek

// The toast is a quick glance at what's playing — auto-dismiss it a few seconds
// after it opens so it never lingers over the UI. Never while a pointer or the
// focus is on it: someone reading it or reaching for a button keeps it open.
const TOAST_AUTO_CLOSE_MS = 7000;

let lcdMark = null; // the blinking mark's cell
let lcdWord = null; // the word on the screen
let lcdSizer = null; // the longest word, unseen: holds the screen's width
let lcdGhost = null; // the unlit segments behind

// The words, in the display's capitals. The screen is as wide as the longer one
// in every state, with as many unlit cells behind.
function lcdWords() {
  const playing = t('nowPlaying.lcdPlaying').toUpperCase();
  const paused = t('nowPlaying.lcdPaused').toUpperCase();
  const longest = playing.length >= paused.length ? playing : paused;
  return { playing, paused, longest };
}
function updateLcd(np) {
  if (!indicator || !(np && np.active)) return;
  loadLcdFont();
  const { playing, paused, longest } = lcdWords();
  lcdSizer.textContent = longest;
  lcdGhost.textContent = LCD_ALL_SEGMENTS.repeat(longest.length);
  lcdWord.textContent = np.paused ? paused : playing;
  lcdMark.innerHTML = np.paused ? LCD_PAUSE : LCD_PLAY;
}

// --- Build (indicator + toast, once) --------------------------------------
export function initNowPlaying(headerActionsEl) {
  if (indicator) return;

  // Header indicator: the screen, tappable. Space is always reserved (visibility
  // toggled) so nothing shifts on appear/disappear. Its name is read aloud; the
  // screen's letters are not.
  indicator = el('button', {
    class: 'np-indicator',
    'aria-label': t('nowPlaying.indicatorAria'),
    'aria-controls': 'np-toast',
    'aria-expanded': 'false',
    onClick: (e) => {
      e.stopPropagation();
      // A click with no pointer behind it (keyboard, a screen reader) also moves
      // the focus into the toast, so its buttons are the next thing reached.
      toggleToast({ focus: e.detail === 0 });
    },
  });
  lcdMark = el('span', { class: 'np-lcd-mark' });
  lcdSizer = el('span', { class: 'np-lcd-sizer' });
  lcdGhost = el('span', { class: 'np-lcd-ghost' });
  lcdWord = el('span', { class: 'np-lcd-text' });
  // The mark's softening filter, defined once beside it.
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  defs.setAttribute('class', 'np-lcd-defs');
  defs.setAttribute('aria-hidden', 'true');
  defs.innerHTML = `<defs>${LCD_SOFT}</defs>`;
  indicator.append(
    el('span', { class: 'np-lcd', 'aria-hidden': 'true' }, [
      defs,
      lcdMark,
      el('span', { class: 'np-lcd-word' }, [lcdSizer, lcdGhost, lcdWord]),
    ])
  );
  if (headerActionsEl) headerActionsEl.prepend(indicator);

  // Toast (built once, reused):
  // [poster] [ tv · Kodi instance / title / SxxExx · episode / audio + subtitle chips ]
  // [ action row: record it in the library ].
  const poster = el('div', { class: 'np-toast-poster' });
  const sourceName = el('span', { class: 'np-toast-source-name' });
  const source = el('div', { class: 'np-toast-source' }, [lucideIcon('tv', 'btn-lucide'), sourceName]);
  const title = el('div', { class: 'np-toast-title' });
  const meta = el('div', { class: 'np-toast-meta' });
  const chips = el('div', { class: 'np-toast-chips' });
  const text = el('div', { class: 'np-toast-text' }, [source, title, meta, chips]);
  const body = el('div', { class: 'np-toast-body' }, [text]);
  const acts = el('div', { class: 'np-act' });
  // Close, for keyboards and screen readers (a finger taps outside instead): out
  // of sight until it has the focus.
  const close = el('button', {
    class: 'np-close sr-only',
    type: 'button',
    text: t('common.close'),
    onClick: () => closeToast(),
  });
  toastEl = el(
    'div',
    { class: 'np-toast', id: 'np-toast', role: 'dialog', 'aria-label': t('nowPlaying.label'), tabindex: '-1' },
    [poster, body, acts, close]
  );
  // Hidden, it is only see-through: inert keeps its buttons out of Tab and away
  // from screen readers until it opens.
  toastEl.inert = true;
  // While it is open the toast is the one thing in play: a light dim over the
  // page (header included) takes every tap outside it. That tap only closes the
  // toast; it never reaches the button, card or link underneath.
  scrim = el('div', { class: 'np-scrim', 'aria-hidden': 'true' });
  scrim.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeToast();
  });
  document.body.append(scrim, toastEl);
  els = { poster, source, sourceName, title, meta, chips, acts, close };

  // A finger, pointer or the focus on the toast holds it open (there is a button
  // to reach now); leaving it starts the peek again.
  const hold = () => clearTimeout(autoCloseTimer);
  const release = () => {
    clearTimeout(autoCloseTimer);
    if (toastOpen && !holding()) autoCloseTimer = setTimeout(autoClose, TOAST_AUTO_CLOSE_MS);
  };
  toastEl.addEventListener('pointerenter', hold);
  toastEl.addEventListener('pointerdown', hold);
  toastEl.addEventListener('pointerleave', () => setTimeout(release));
  toastEl.addEventListener('focusin', hold);
  toastEl.addEventListener('focusout', (e) => {
    if (!toastEl.contains(e.relatedTarget)) setTimeout(release);
  });
  // Esc closes it, like any dialog.
  document.addEventListener('keydown', (e) => {
    if (toastOpen && e.key === 'Escape') closeToast();
  });
  // An Undo resets the row: rebuild it from the latest snapshot.
  toastEl.addEventListener('np-act-reset', () => {
    const np = getNowPlaying();
    if (toastOpen && np && np.active) fillToast(np);
  });


  window.addEventListener('shelfit:kodi-nowplaying', (e) => render(e.detail || getNowPlaying()));
  // The indicator and toast outlive page renders — relabel them on a language switch.
  onLangChange(() => {
    indicator.setAttribute('aria-label', t('nowPlaying.indicatorAria'));
    updateLcd(getNowPlaying());
    toastEl.setAttribute('aria-label', t('nowPlaying.label'));
    els.close.textContent = t('common.close');
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
  if (indicator) {
    // Paused on Kodi: the screen reads PAUSE, its mark ‖.
    const paused = active && !!np.paused;
    const changed =
      indicator.classList.contains('active') !== active || indicator.classList.contains('paused') !== paused;
    indicator.classList.toggle('active', active);
    indicator.classList.toggle('paused', paused);
    // Repainted on a change of state only: the snapshot refreshes every few
    // seconds, and a repaint would restart the mark's blink.
    if (changed) updateLcd(np);
  }
  applyRing(np);

  if (toastOpen) {
    if (!active) closeToast();
    else fillToast(np); // keep an open toast in sync
  }
}

// --- Toast content --------------------------------------------------------
// One audio / subtitle chip: a Lucide glyph and its text.
function trackChip(icon, text) {
  return el('span', { class: 'np-chip' }, [lucideIcon(icon, 'btn-lucide'), el('span', { text })]);
}

function fillToast(np) {
  const isEp = np.media_type === 'episode';
  toastEl.classList.toggle('paused', !!np.paused);

  // Which Kodi is playing: the instance's own name (absent → the line hides).
  els.sourceName.textContent = np.instance || '';
  els.source.style.display = np.instance ? '' : 'none';

  // Poster: local shelfIt TMDB cache first (matched titles); otherwise Kodi's own
  // artwork, proxied through the server; skeleton when neither is available.
  // `_src` guards against rebuilding (and re-fetching) on every poll while open.
  let posterSrc = null;
  if (np.match && np.match.poster_url) posterSrc = np.match.poster_url;
  else if (np.kodi_poster)
    posterSrc = `/api/kodi/now-playing/poster?k=${encodeURIComponent(posterKey(np))}`;

  if (posterSrc !== els.poster._src) {
    els.poster._src = posterSrc;
    els.poster.replaceChildren();
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

  // Title, then season/episode plus the episode's own title, or the year for a movie.
  els.title.textContent = isEp ? np.show_title || t('nowPlaying.fallbackTitle') : np.title || t('nowPlaying.fallbackTitle');
  const parts = [];
  if (isEp) {
    if (np.season > 0)
      parts.push(`S${String(np.season).padStart(2, '0')} · E${String(np.episode || 0).padStart(2, '0')}`);
    else if (np.episode > 0) parts.push(t('nowPlaying.episode', { episode: np.episode }));
    // For an episode `title` is the episode's name; skip it when Kodi gave none
    // beyond the show's name.
    if (np.title && np.title !== np.show_title) parts.push(np.title);
  } else if (np.year) {
    parts.push(String(np.year));
  }
  // Drop the meta line when it would just repeat the heading (e.g. a bare
  // "Episode 7" with no show/season resolved).
  let metaText = parts.join(' · ');
  if (metaText && metaText === els.title.textContent) metaText = '';
  els.meta.textContent = metaText;
  els.meta.style.display = metaText ? '' : 'none';

  // Audio (language · codec) and subtitles as two small chips. The subtitle chip
  // always shows, reading "none" when subtitles are off.
  const audio = np.audio
    ? [np.audio.language && np.audio.language.toUpperCase(), np.audio.codec].filter(Boolean).join(' · ')
    : '';
  const sub = np.subtitle && np.subtitle.language ? np.subtitle.language.toUpperCase() : t('nowPlaying.subtitlesOff');
  els.chips.replaceChildren(
    ...[
      audio ? trackChip('volume-2', audio) : null,
      trackChip('captions', sub),
    ].filter(Boolean)
  );

  fillActions(els.acts, np, { onBusy: () => clearTimeout(autoCloseTimer) });
}

// --- Open / close ---------------------------------------------------------
function holding() {
  return toastEl.matches(':hover') || toastEl.contains(document.activeElement);
}
// The timer's close: not from under someone using the toast.
function autoClose() {
  if (holding()) return;
  closeToast();
}
function toggleToast({ focus = false } = {}) {
  if (toastOpen) closeToast();
  else openToast({ focus });
}
function openToast({ focus = false } = {}) {
  const np = getNowPlaying();
  if (!toastEl || !(np && np.active) || overlayOpen()) return; // idle / behind a modal → nothing
  fillToast(np);
  // Settle just below the header (measured live, so safe-area insets are honoured).
  const header = document.querySelector('.app-header');
  const top = header ? header.getBoundingClientRect().bottom + 8 : 72;
  toastEl.style.top = `${Math.round(top)}px`;
  toastEl.classList.remove('dismissing');
  toastEl.inert = false;
  scrim.classList.add('show');
  requestAnimationFrame(() => toastEl.classList.add('show'));
  toastOpen = true;
  if (indicator) indicator.setAttribute('aria-expanded', 'true');
  if (focus) toastEl.focus({ preventScroll: true });
  // Auto-dismiss after a brief peek.
  clearTimeout(autoCloseTimer);
  autoCloseTimer = setTimeout(autoClose, TOAST_AUTO_CLOSE_MS);
}
function closeToast() {
  if (!toastEl) return;
  clearTimeout(autoCloseTimer);
  autoCloseTimer = null;
  if (indicator) indicator.setAttribute('aria-expanded', 'false');
  // The focus was in the toast: back to the button that opens it, rather than
  // lost with the toast (inert drops it to the page).
  if (toastEl.contains(document.activeElement)) {
    if (indicator && indicator.classList.contains('active')) indicator.focus({ preventScroll: true });
    else document.activeElement.blur();
  }
  toastEl.classList.add('dismissing');
  toastEl.classList.remove('show');
  if (scrim) scrim.classList.remove('show');
  toastEl.inert = true;
  toastOpen = false;
}

// Leaving the page (its "Open the series" link, a tab, Back) takes the toast
// away with it, instead of leaving it over the next page until its timer runs out.
export function dismissNowPlaying() {
  if (toastOpen) closeToast();
}

// Never overlap an open modal / bottom sheet.
function overlayOpen() {
  return !!document.querySelector('.modal-backdrop');
}
