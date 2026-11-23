// Kodi "Now Playing" UI:
//   • a small header indicator, a deck's LCD with "▶ NOW PLAYING" stepping
//     through it: tap to open the toast
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
import { withBase } from './basePath.js';

const KODI_BLUE = '#17B2E8';

// --- The header's LCD -------------------------------------------------------
// Seven character cells in a 14-segment display font. While playing, "▶ NOW
// PLAYING" steps right to left through them, one whole letter a second; paused,
// they hold "‖ PAUSE" (and blink, in CSS). The ▶ and ‖ are drawn, so they sit in
// a cell like the letters. Reduced motion holds still on "▶ PLAY".
const LCD_CELLS = 7;
const LCD_STEP_MS = 1000;
const LCD_FONT = 'DSEG14 Modern';
const LCD_FONT_URL = '/font/DSEG14Modern-Regular.woff2'; // SIL OFL, see DSEG-LICENSE.txt beside it
const LCD_ALL_SEGMENTS = '~'; // the font's "every segment" glyph: the unlit ghost behind
const LCD_PLAY = '<svg viewBox="0 0 10 12" aria-hidden="true"><path d="M1 .5 9.5 6 1 11.5z"/></svg>';
const LCD_PAUSE =
  '<svg viewBox="0 0 10 12" aria-hidden="true"><rect x="1.2" y=".5" width="2.8" height="11"/><rect x="6" y=".5" width="2.8" height="11"/></svg>';

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

let lcdCells = []; // the seven cells of the header's screen
let lcdTimer = 0; // steps the marquee while playing
let lcdPos = 0; // the marquee's first character in the window
let lcdFontAsked = false;

const motionReduced = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// What runs through the screen: the play mark, the words, a short gap, again.
const lcdMessage = () => ['▶', ' ', ...t('nowPlaying.lcd').toUpperCase(), ' ', ' ', ' '];

// Fetched only once something plays (a 6 KB file), from the app itself (the
// Content-Security-Policy allows fonts from 'self' only), under the app's path.
function loadLcdFont() {
  if (lcdFontAsked || typeof FontFace !== 'function') return;
  lcdFontAsked = true;
  const face = new FontFace(LCD_FONT, `url("${withBase(LCD_FONT_URL)}") format('woff2')`);
  face
    .load()
    .then(() => document.fonts.add(face))
    .catch(() => {
      lcdFontAsked = false; // try again on the next play
    });
}

function paintLcd(chars) {
  chars.forEach((ch, i) => {
    const cell = lcdCells[i];
    if (!cell) return;
    cell.classList.toggle('is-blank', ch === ' ');
    if (ch === '▶') cell.innerHTML = LCD_PLAY;
    else if (ch === '‖') cell.innerHTML = LCD_PAUSE;
    else cell.textContent = ch === ' ' ? '!' : ch; // "!" is the font's blank cell
  });
}
function stopLcd() {
  clearInterval(lcdTimer);
  lcdTimer = 0;
}
// Set the screen for `np`: off, held on pause, still (reduced motion), or stepping.
function updateLcd(np) {
  stopLcd();
  if (!indicator || !(np && np.active)) return;
  loadLcdFont();
  if (np.paused) {
    paintLcd(['‖', ' ', ...t('nowPlaying.lcdPaused').toUpperCase()].slice(0, LCD_CELLS));
    return;
  }
  if (motionReduced()) {
    paintLcd(['▶', ' ', ...t('nowPlaying.lcdStill').toUpperCase(), ' ', ' ', ' '].slice(0, LCD_CELLS));
    return;
  }
  const step = () => {
    const msg = lcdMessage();
    lcdPos %= msg.length;
    paintLcd(Array.from({ length: LCD_CELLS }, (_, i) => msg[(lcdPos + i) % msg.length]));
  };
  step();
  // A hidden page has nothing to show it to: the steps wait until it is back.
  if (document.visibilityState === 'hidden') return;
  lcdTimer = setInterval(() => {
    lcdPos += 1;
    step();
  }, LCD_STEP_MS);
}

// --- Build (indicator + toast, once) --------------------------------------
export function initNowPlaying(headerActionsEl) {
  if (indicator) return;

  // Header indicator: the LCD, tappable. Space is always reserved (visibility
  // toggled) so nothing shifts on appear/disappear. Its name is read aloud; the
  // moving letters are not.
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
  const ghost = el('span', { class: 'np-lcd-row np-lcd-ghost' });
  const live = el('span', { class: 'np-lcd-row np-lcd-live' });
  for (let i = 0; i < LCD_CELLS; i++) {
    ghost.append(el('span', { class: 'np-lcd-c', text: LCD_ALL_SEGMENTS }));
    const cell = el('span', { class: 'np-lcd-c is-blank', text: '!' });
    live.append(cell);
    lcdCells.push(cell);
  }
  indicator.append(el('span', { class: 'np-lcd', 'aria-hidden': 'true' }, [ghost, live]));
  if (headerActionsEl) headerActionsEl.prepend(indicator);
  document.addEventListener('visibilitychange', () => updateLcd(getNowPlaying()));

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
    // Paused on Kodi: the screen holds "‖ PAUSE" and blinks.
    const paused = active && !!np.paused;
    const changed =
      indicator.classList.contains('active') !== active || indicator.classList.contains('paused') !== paused;
    indicator.classList.toggle('active', active);
    indicator.classList.toggle('paused', paused);
    // Only a change of state restarts the screen: the snapshot refreshes every
    // few seconds, and the marquee must not jump back each time.
    if (changed || !lcdTimer) updateLcd(np);
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
