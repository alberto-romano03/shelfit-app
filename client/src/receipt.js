// Monthly Rental Receipt — a shareable "wrapped"-style card styled as a 1990s
// video-store thermal receipt. The on-screen preview is HTML/CSS; "Save as
// image" re-draws the very same layout onto a 1080×1920 (9:16) <canvas>,
// supersampled ×EXPORT_SCALE for a crisper JPEG. Both renderers are driven by ONE
// row list + ONE set of geometry constants below, so preview and export stay in
// sync.

import { api } from './api.js';
import {
  el,
  toast,
  spinner,
  openSheet,
  icons,
  setLabel,
  lucideIcon,
  stateBlock,
} from './ui.js';
import { withBase } from './basePath.js';
import { imageCache } from './imageCache.js';
import { boxBlur } from './blur.js';
import { t } from './i18n.js';

// --- Fixed export canvas (9:16 portrait) — the design coordinate system ------
// All layout below is authored in this 1080×1920 space. The export supersamples
// it by EXPORT_SCALE for a higher-DPI (crisper) image without changing any of the
// geometry — kept modest so the JPEG stays light.
const CARD_W = 1080;
const CARD_H = 1920;
const EXPORT_SCALE = 2; // export at 2160×3840 (2× the 1080×1920 design)
// The receipt uses a custom "Fake Receipt" webfont (client/public/font), falling
// back to Courier New until it loads / if it fails. It's monospaced, so the layout
// math below (CHAR_W advance, divider length, title truncation) stays aligned.
const FONT = "'Fake Receipt', 'Courier New', 'Courier', ui-monospace, monospace";
const RECEIPT_FONT_URL = '/font/Fake-Receipt.woff';
const LOGO_URL = '/icons/receipt-logo.png'; // dedicated receipt store logo

// Load + register the custom font once, so BOTH the HTML preview (via CSS) and the
// canvas export (which silently falls back unless the face is loaded first) can
// use it. Resolves even on failure — the receipt just keeps the Courier fallback.
let _receiptFontPromise = null;
function ensureReceiptFont() {
  if (_receiptFontPromise) return _receiptFontPromise;
  if (typeof FontFace === 'undefined' || !(document.fonts && document.fonts.add)) {
    _receiptFontPromise = Promise.resolve();
    return _receiptFontPromise;
  }
  const face = new FontFace('Fake Receipt', `url("${withBase(RECEIPT_FONT_URL)}")`);
  _receiptFontPromise = face
    .load()
    .then((f) => {
      document.fonts.add(f);
    })
    .catch(() => {});
  return _receiptFontPromise;
}

const PAPER_W = 860;
const PAD_X = 66; // inner horizontal padding of the paper
const PAD_Y = 54; // inner vertical padding (above teeth)
const CONTENT_W = PAPER_W - PAD_X * 2;
const TOOTH_W = 26; // torn-edge zigzag tooth width
const TOOTH_H = 16; // torn-edge zigzag depth
const CHAR_W = 0.6; // monospace advance in em (Courier)
const ITEM_GAP = 16; // min gap between an item's title and its right-aligned metric

// Month picker labels. MONTH_NAMES mirrors the server's `month_name`, so the
// month the server actually rendered can be mapped back to a YYYY-MM key.
const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];
// Month ids for the translated labels (receipt.monthShort.* / receipt.month.*).
const MONTH_IDS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The server's rotating closing line is CLOSINGS[monthIndex % 6]; the client
// mirrors it with receipt.closing.0–5 so the line can be translated.
const CLOSING_COUNT = 6;
const monthKeyOf = (year, monthIndex) => `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

// Per-row heights (design px). Spacing is baked in so cumulative y matches
// exactly between the HTML flow and the canvas.
const ROWH = {
  logo: 190,
  month: 60,
  divider: 46,
  sect: 52,
  item: 46,
  sub: 32,
  sep: 46,
  total: 52,
  closing: 96,
  more: 42,
};
const FSIZE = {
  month: 40,
  divider: 30,
  sect: 27,
  item: 34,
  sub: 23,
  sep: 28,
  total: 34,
  closing: 32,
  more: 24,
};

// A dashed divider sized to exactly span the content width.
const DIVIDER = '-'.repeat(Math.floor(CONTENT_W / (FSIZE.divider * CHAR_W)));

// Three selectable paper looks — all within a lo-fi receipt world.
const PAPERS = {
  white: { bg: '#ffffff', ink: '#161616', faint: '#5f5f5f', line: '#333333', tex: '0,0,0', blend: 'multiply' },
  aged: { bg: '#e9d6a2', ink: '#40320f', faint: '#7c6a38', line: '#5c4a1e', tex: '40,25,0', blend: 'multiply' },
  dark: { bg: '#1c1b19', ink: '#ece7dd', faint: '#928a7d', line: '#4a453d', tex: '255,255,255', blend: 'screen' },
};
// Fixed-step overlay presets (not a free slider).
const DIMS = [
  ['Off', 0],
  ['Light', 0.35],
  ['Medium', 0.6],
  ['Heavy', 0.85],
];
// Blur radii are in the 1080px design space; the preview scales the whole card
// down (~0.25×), so these need to be large to read as blur on screen (and they
// match 1:1 in the full-resolution export).
const BLURS = [
  ['receipt.blur.off', 0],
  ['receipt.blur.light', 22],
  ['receipt.blur.medium', 50],
  ['receipt.blur.heavy', 90],
];

// "None" background → a generic, diffuse blur built from the app's palette
// (amber accent dominant, with green/red hints over the dark base). Rendered
// identically as CSS radial-gradients (preview/thumbnail) and on canvas (export).
// Blobs are listed bottom→top (last is painted on top).
const NONE_BASE = '#141210';
const NONE_BLOBS = [
  { x: 0.18, y: 0.18, r: 0.66, c: '229,160,13', a: 0.55 }, // --accent (amber)
  { x: 0.86, y: 0.24, r: 0.52, c: '229,72,77', a: 0.26 }, //  --danger (warm)
  { x: 0.80, y: 0.82, r: 0.6, c: '76,175,80', a: 0.3 }, //    --success (green)
  { x: 0.28, y: 0.86, r: 0.55, c: '229,160,13', a: 0.35 }, // --accent again
];
// CSS `background-image` value (first listed paints on top → reverse the array).
function noneBgCss() {
  return [...NONE_BLOBS]
    .reverse()
    .map(
      (b) =>
        `radial-gradient(circle at ${(b.x * 100).toFixed(0)}% ${(b.y * 100).toFixed(0)}%, ` +
        `rgba(${b.c},${b.a}) 0%, rgba(${b.c},0) ${(b.r * 100).toFixed(0)}%)`
    )
    .join(', ');
}
// Canvas equivalent: opaque base, then each soft radial blob bottom→top.
function drawNoneBg(ctx, W, H) {
  ctx.fillStyle = NONE_BASE;
  ctx.fillRect(0, 0, W, H);
  const diag = Math.hypot(W, H);
  for (const b of NONE_BLOBS) {
    const cx = b.x * W;
    const cy = b.y * H;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, b.r * diag);
    g.addColorStop(0, `rgba(${b.c},${b.a})`);
    g.addColorStop(1, `rgba(${b.c},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

// Flat background colours for the "Solid color" option (a compact spread).
const COLORS = ['#141210', '#2a2a30', '#0d1b2a', '#16281c', '#3a1a1a', '#e9d6a2'];
// Gradient presets — rendered as CSS in the preview and on canvas for export.
const GRADIENTS = [
  { nameKey: 'receipt.gradient.ember', deg: 160, stops: [['#f0a875', 0], ['#7a2e1e', 55], ['#1a1210', 100]] },
  { nameKey: 'receipt.gradient.dusk', deg: 165, stops: [['#6a4ea0', 0], ['#26305a', 55], ['#0d0f1a', 100]] },
  { nameKey: 'receipt.gradient.forest', deg: 160, stops: [['#5aa96a', 0], ['#234a2c', 60], ['#0e140f', 100]] },
  { nameKey: 'receipt.gradient.slate', deg: 160, stops: [['#565b66', 0], ['#23262c', 100]] },
  { nameKey: 'receipt.gradient.gold', deg: 160, stops: [['#e9d6a2', 0], ['#8a6a2f', 55], ['#2a2010', 100]] },
  { nameKey: 'receipt.gradient.rose', deg: 160, stops: [['#f090b6', 0], ['#7a2e4a', 60], ['#1a1015', 100]] },
];
function gradientCss(g) {
  return `linear-gradient(${g.deg}deg, ${g.stops.map(([c, p]) => `${c} ${p}%`).join(', ')})`;
}
function drawGradient(ctx, g, W, H) {
  const rad = (g.deg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const len = Math.abs(W * dx) + Math.abs(H * dy);
  const cx = W / 2;
  const cy = H / 2;
  const grad = ctx.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
  g.stops.forEach(([c, p]) => grad.addColorStop(Math.min(1, Math.max(0, p / 100)), c));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

// --- Row list (the single source of truth for both renderers) ----------------
function truncateTo(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…';
}

// One movie/show line: title (left) + metric (right), truncating the title to
// the room left. A movie rewatch line is flagged with a "REWATCH" sub-line;
// shows keep the xN rewatch-times sub-line.
function itemRows(title, right, rewatchTimes, fontPx, rewatch) {
  const charPx = fontPx * CHAR_W;
  const maxTitle = Math.max(6, Math.floor(CONTENT_W / charPx) - right.length - 2);
  const rows = [{ type: 'item', left: truncateTo(title, maxTitle), right }];
  if (rewatch) rows.push({ type: 'sub', text: t('receipt.rewatch') });
  else if (rewatchTimes > 1) rows.push({ type: 'sub', text: `x${rewatchTimes}` });
  return rows;
}

function buildRows(data) {
  const rows = [];
  rows.push({ type: 'logo' }); // the store logo already includes the wordmark
  // The month header, hours unit and closing line arrive pre-rendered in English
  // from the server; rebuild them from keys (same output in English) when the
  // month can be mapped back, else show the server text as-is.
  const mi = MONTH_NAMES.indexOf(data.month_name);
  const monthLabel =
    mi >= 0 ? t('receipt.monthLabel', { month: t(`receipt.month.${MONTH_IDS[mi]}`), year: data.year }) : data.month_label;
  rows.push({ type: 'center', hkey: 'month', fkey: 'month', text: monthLabel, bold: true });
  rows.push({ type: 'divider' });

  const CAP = 16; // guard against a runaway tiny-text scale on huge months
  if (data.movies.length) {
    rows.push({ type: 'sect', text: t('receipt.sectMovies') });
    data.movies.slice(0, CAP).forEach((m) => {
      const right = m.minutes > 0 ? t('receipt.minutes', { minutes: m.minutes }) : '–';
      rows.push(...itemRows(m.title, right, m.times, FSIZE.item, m.rewatch));
    });
    if (data.movies.length > CAP)
      rows.push({ type: 'more', text: t('receipt.more', { count: data.movies.length - CAP }) });
  }

  if (data.movies.length && data.shows.length)
    rows.push({ type: 'sep', text: '·–·–·–·–·–·–·–·–·–·' });

  if (data.shows.length) {
    rows.push({ type: 'sect', text: t('receipt.sectShows') });
    data.shows.slice(0, CAP).forEach((s) => {
      rows.push(...itemRows(s.title, t('receipt.episodes', { episodes: s.episodes }), s.times, FSIZE.item));
    });
    if (data.shows.length > CAP)
      rows.push({ type: 'more', text: t('receipt.more', { count: data.shows.length - CAP }) });
  }

  if (!data.movies.length && !data.shows.length)
    rows.push({ type: 'center', hkey: 'sect', fkey: 'sect', text: t('receipt.noRentals'), faint: true });

  rows.push({ type: 'divider' });
  const totals = data.totals;
  const hrs = / HRS$/.test(totals.hours_label || '')
    ? t('receipt.hours', { time: totals.hours_label.replace(/ HRS$/, '') })
    : totals.hours_label;
  rows.push({ type: 'total', left: t('receipt.titlesWatched'), right: String(totals.total_titles) });
  rows.push({ type: 'total', left: t('receipt.totalHours'), right: hrs });
  if (totals.top_genre) rows.push({ type: 'total', left: t('receipt.topGenre'), right: totals.top_genre });
  rows.push({ type: 'divider' });
  rows.push({ type: 'closing', text: mi >= 0 ? t(`receipt.closing.${mi % CLOSING_COUNT}`) : totals.closing });
  return rows;
}

function rowHeight(r) {
  if (r.type === 'center') return ROWH[r.hkey] || ROWH.month;
  return ROWH[r.type] || ROWH.item;
}
function rowFont(r) {
  if (r.type === 'center') return FSIZE[r.fkey] || FSIZE.month;
  return FSIZE[r.type] || FSIZE.item;
}
function paperHeight(rows) {
  let h = PAD_Y * 2;
  for (const r of rows) h += rowHeight(r);
  return h;
}

// Torn-edge outline points (relative to paper top-left), used identically by the
// HTML clip-path and the canvas fill.
function tornPoints(w, h) {
  const pts = [];
  const n = Math.max(2, Math.round(w / TOOTH_W));
  const step = w / n;
  for (let i = 0; i <= n; i++) pts.push([i * step, i % 2 === 0 ? TOOTH_H : 0]);
  pts.push([w, h - TOOTH_H]);
  for (let i = n; i >= 0; i--) pts.push([i * step, i % 2 === 0 ? h - TOOTH_H : h]);
  return pts;
}

// --- HTML row rendering ------------------------------------------------------
function htmlRow(r, colors) {
  const h = rowHeight(r);
  const f = rowFont(r);
  const base = {
    position: 'relative',
    height: `${h}px`,
    lineHeight: `${h}px`,
    fontFamily: FONT,
    fontSize: `${f}px`,
    color: colors.ink,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  };
  if (r.type === 'logo') {
    const box = el('div', { class: 'rcpt-logo-slot', style: { height: `${h}px` } });
    const img = el('img', { class: 'rcpt-logo-img', src: withBase(LOGO_URL), alt: '' });
    img.addEventListener('error', () => img.remove()); // no file → wordmark only
    box.append(img);
    return box;
  }
  if (r.type === 'center') {
    return el('div', { style: { ...base, textAlign: 'center', fontWeight: r.bold ? '800' : '400', color: r.faint ? colors.faint : colors.ink, letterSpacing: '1px' }, text: r.text });
  }
  if (r.type === 'divider') {
    return el('div', { style: { ...base, textAlign: 'center', color: colors.line }, text: DIVIDER });
  }
  if (r.type === 'sect') {
    return el('div', { style: { ...base, textAlign: 'center', fontWeight: '700', letterSpacing: '3px', color: colors.faint }, text: r.text });
  }
  if (r.type === 'sep') {
    return el('div', { style: { ...base, textAlign: 'center', color: colors.line }, text: r.text });
  }
  if (r.type === 'more') {
    return el('div', { style: { ...base, textAlign: 'right', color: colors.faint, fontStyle: 'italic' }, text: r.text });
  }
  if (r.type === 'sub') {
    return el('div', { style: { ...base, color: colors.faint, letterSpacing: '1px' }, text: r.text });
  }
  if (r.type === 'closing') {
    return el('div', { style: { ...base, textAlign: 'center', fontWeight: '800', letterSpacing: '2px' }, text: r.text });
  }
  // item / total → left + right
  const left = el('span', { style: { fontFamily: FONT, fontSize: `${f}px`, color: colors.ink, fontWeight: r.type === 'total' ? '700' : '400', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: r.left });
  const right = el('span', { style: { fontFamily: FONT, fontSize: `${f}px`, color: colors.ink, fontWeight: '700', flexShrink: '0', paddingLeft: '16px' }, text: r.right });
  return el('div', { style: { ...base, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [left, right]);
}

// --- Canvas row rendering ----------------------------------------------------
// Trim `text` (with a trailing ellipsis) until it actually fits `maxWidth` at the
// font currently set on `ctx`. buildRows already truncates by an ESTIMATED char
// advance (CHAR_W, Courier); the real "Fake Receipt" face is a little wider, so
// the estimate can still overrun. The HTML preview hides that with a CSS ellipsis
// clip — canvas has no such thing, so long titles used to run under the minutes.
// This is the exact, measured backstop. Binary-searches the longest prefix.
function fitText(ctx, text, maxWidth) {
  if (!text || maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid).trimEnd() + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo).trimEnd() + '…' : '';
}

function canvasRows(ctx, rows, colors, cdImg) {
  let y = PAD_Y;
  for (const r of rows) {
    const h = rowHeight(r);
    const f = rowFont(r);
    const cy = y + h / 2;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.ink;

    if (r.type === 'logo') {
      if (cdImg) {
        const maxH = h - 70;
        const s = Math.min(maxH / cdImg.height, CONTENT_W / cdImg.width);
        const w = cdImg.width * s;
        const hh = cdImg.height * s;
        ctx.drawImage(cdImg, PAPER_W / 2 - w / 2, y + (h - hh) / 2, w, hh);
      }
    } else if (r.type === 'center') {
      ctx.font = `${r.bold ? '800' : '400'} ${f}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = r.faint ? colors.faint : colors.ink;
      ctx.fillText(r.text, PAPER_W / 2, cy);
    } else if (r.type === 'divider') {
      ctx.font = `400 ${f}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = colors.line;
      ctx.fillText(DIVIDER, PAPER_W / 2, cy);
    } else if (r.type === 'sect') {
      ctx.font = `700 ${f}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = colors.faint;
      ctx.fillText(r.text, PAPER_W / 2, cy);
    } else if (r.type === 'sep') {
      ctx.font = `400 ${f}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = colors.line;
      ctx.fillText(r.text, PAPER_W / 2, cy);
    } else if (r.type === 'more') {
      ctx.font = `italic 400 ${f}px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = colors.faint;
      ctx.fillText(r.text, PAPER_W - PAD_X, cy);
    } else if (r.type === 'sub') {
      ctx.font = `400 ${f}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = colors.faint;
      ctx.fillText(r.text, PAD_X, cy);
    } else if (r.type === 'closing') {
      ctx.font = `800 ${f}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(r.text, PAPER_W / 2, cy);
    } else {
      const leftFont = `${r.type === 'total' ? '700' : '400'} ${f}px ${FONT}`;
      const rightFont = `700 ${f}px ${FONT}`;
      // Measure the right-aligned metric first, then fit the title into the space
      // that's actually left so the two can never overlap.
      ctx.font = rightFont;
      const rightW = ctx.measureText(r.right || '').width;
      ctx.font = leftFont;
      ctx.textAlign = 'left';
      ctx.fillText(fitText(ctx, r.left, CONTENT_W - rightW - ITEM_GAP), PAD_X, cy);
      ctx.textAlign = 'right';
      ctx.font = rightFont;
      ctx.fillText(r.right, PAPER_W - PAD_X, cy);
    }
    y += h;
  }
}

// --- Image loading (same-origin only → canvas stays untainted) ---------------
function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = withBase(url);
  });
}

// Blur the poster with a pure pixel-data blur (see blur.js) rather than a CSS or
// canvas `filter`, which iOS Safari ignores here. We work at a reduced 9:16
// resolution (fast; the result is upscaled to fill and is blurry anyway) and
// return the small blurred canvas, shared by the preview and the export so they
// look identical.
const BLUR_WORK_W = 480;
const BLUR_WORK_H = Math.round((BLUR_WORK_W * CARD_H) / CARD_W); // 9:16
function makeBlurredCanvas(img, blurPx) {
  const W = BLUR_WORK_W;
  const H = BLUR_WORK_H;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const cx = c.getContext('2d');
  const s = Math.max(W / img.width, H / img.height); // cover-fit
  const w = img.width * s;
  const h = img.height * s;
  cx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  const r = Math.max(1, Math.round((blurPx * W) / CARD_W)); // radius at work scale
  const id = cx.getImageData(0, 0, W, H);
  boxBlur(id, r, 3);
  cx.putImageData(id, 0, 0);
  return c;
}

// Resolve the CSS `background-image` value for the chosen poster (a ready-blurred
// data URL when a blur is active — no render-time filter, so it paints on iOS).
let _blurCache = { key: null, css: null };
async function posterBackgroundCss(posterUrl, blurPx) {
  const objUrl = await imageCache.load(posterUrl); // cached object URL
  if (!blurPx) return `url("${objUrl}")`;
  const key = `${posterUrl}|${blurPx}`;
  if (_blurCache.key === key) return _blurCache.css;
  const img = await loadImage(objUrl); // blob: URL — withBase passes it through
  if (!img || !img.width) return `url("${objUrl}")`;
  try {
    const css = `url("${makeBlurredCanvas(img, blurPx).toDataURL('image/jpeg', 0.9)}")`;
    _blurCache = { key, css };
    return css;
  } catch {
    return `url("${objUrl}")`; // any failure → sharp poster, never blank
  }
}

// Opens the receipt sheet. `month` is an optional 'YYYY-MM' key: omit it for the
// current month, or pass a past month to build that month's receipt instead
// (e.g. openReceipt('2026-08')). Guarded so the function stays safe to use as a
// direct event handler — Home passes it straight to onClick, which would
// otherwise hand us a MouseEvent as the "month".
export function openReceipt(month) {
  const monthArg = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) ? month : null;
  openSheet((sheet, close) => {
    // --- Month picker (rounded calendar button, top-right of the header) -----
    const NOW = new Date();
    const CUR_KEY = monthKeyOf(NOW.getFullYear(), NOW.getMonth());
    // The month currently on screen. Starts as whatever was requested, then is
    // re-synced from each response so the highlight always matches what the
    // SERVER actually rendered (immune to client/server timezone drift).
    let activeKey = monthArg || CUR_KEY;
    let pickerYear = Number(activeKey.slice(0, 4));

    const calBtn = el('button', {
      class: 'rcpt-month-btn',
      type: 'button',
      'aria-label': t('receipt.chooseMonth'),
    }, [lucideIcon('calendar', 'rcpt-cal-ico')]);

    const yearLabel = el('span', { class: 'rcpt-mp-year' });
    const prevY = el('button', { class: 'rcpt-mp-nav', type: 'button', html: icons.back, 'aria-label': t('receipt.prevYear') });
    const nextY = el('button', { class: 'rcpt-mp-nav rcpt-mp-next', type: 'button', html: icons.back, 'aria-label': t('receipt.nextYear') });
    const monthBtns = MONTH_IDS.map((id, i) => {
      const b = el('button', { class: 'rcpt-mp-m', type: 'button', text: t(`receipt.monthShort.${id}`) });
      b.addEventListener('click', () => {
        if (b.disabled) return;
        const key = monthKeyOf(pickerYear, i);
        togglePicker(false);
        if (key !== activeKey) loadMonth(key);
      });
      return b;
    });
    const picker = el('div', { class: 'rcpt-monthpicker' }, [
      el('div', { class: 'rcpt-mp-head' }, [prevY, yearLabel, nextY]),
      el('div', { class: 'rcpt-mp-grid' }, monthBtns),
    ]);
    picker.hidden = true;

    // Months after the current one have no receipt, so they stay disabled.
    function renderMonthPicker() {
      yearLabel.textContent = String(pickerYear);
      nextY.disabled = pickerYear >= NOW.getFullYear();
      prevY.disabled = pickerYear <= 1970;
      monthBtns.forEach((b, i) => {
        const key = monthKeyOf(pickerYear, i);
        const future = key > CUR_KEY;
        b.disabled = future;
        b.classList.toggle('is-disabled', future);
        b.classList.toggle('is-active', key === activeKey);
      });
    }
    function togglePicker(open) {
      const show = open === undefined ? picker.hidden : open;
      if (show) {
        pickerYear = Number(activeKey.slice(0, 4));
        renderMonthPicker();
      }
      picker.hidden = !show;
      calBtn.classList.toggle('is-open', show);
    }
    prevY.addEventListener('click', () => {
      pickerYear -= 1;
      renderMonthPicker();
    });
    nextY.addEventListener('click', () => {
      pickerYear += 1;
      renderMonthPicker();
    });
    calBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePicker();
    });
    // Tapping anywhere else in the sheet dismisses the picker.
    sheet.addEventListener('click', (e) => {
      if (!picker.hidden && !picker.contains(e.target) && !calBtn.contains(e.target)) togglePicker(false);
    });

    // No close/cross button — Cancel (in the footer) is the sole dismissal.
    const header = el('div', { class: 'sheet-header rcpt-header' }, [
      el('h3', { text: t('receipt.title') }),
      calBtn,
      picker,
    ]);
    const body = el('div', { class: 'sheet-body' });
    const saveBtn = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('printer', 'btn-lucide'),
      el('span', { text: t('receipt.print') }),
    ]);
    saveBtn.addEventListener('click', () => exportImage(saveBtn));
    const footer = el('div', { class: 'sheet-footer rcpt-footer' }, [
      el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
      saveBtn,
    ]);
    sheet.append(header, body, footer);

    // bgType: 'poster' | 'color' | 'gradient'. Blur applies to the poster only.
    const state = { bgType: 'poster', posterUrl: null, color: COLORS[0], gradient: 0, blur: 0, blurOpen: false, paper: 'white' };
    let data = null;
    let renderToken = 0; // guards against a slow async blur overwriting a newer render
    let backgrounds = []; // { title, poster_url } from the receipt's own titles

    // Fetch + render one month. `key` null → the server's own current month (the
    // default open), avoiding any client/server timezone disagreement. Re-callable:
    // the picker swaps months in place without reopening the sheet.
    let loadToken = 0;
    function loadMonth(key) {
      const token = ++loadToken;
      body.innerHTML = '';
      body.append(spinner());
      api
        .receipt(key)
        .then((r) => {
          if (token !== loadToken) return; // a newer month won the race
          data = r;
          // Re-sync the highlight to the month the server actually built.
          const mi = MONTH_NAMES.indexOf(data.month_name);
          if (mi >= 0) activeKey = monthKeyOf(data.year, mi);
          const seen = new Set();
          backgrounds = [...data.movies, ...data.shows].filter((it) => {
            if (!it.poster_url || seen.has(it.poster_url)) return false;
            seen.add(it.poster_url);
            return true;
          });
          state.posterUrl = backgrounds.length ? backgrounds[0].poster_url : null;
          if (!backgrounds.length) state.bgType = 'color'; // no posters → solid colour
          build();
        })
        .catch(() => {
          if (token !== loadToken) return;
          body.innerHTML = '';
          body.append(
            stateBlock({
              kind: 'error',
              tier: 'section',
              icon: 'receipt',
              title: key ? t('receipt.loadErrorThat') : t('receipt.loadErrorThis'),
            })
          );
        });
    }
    loadMonth(monthArg);

    // --- Preview (HTML card at 1080×1920, scaled so the container fits it
    // exactly — no letterboxing) --------------------------------------------
    const preview = el('div', { class: 'rcpt-preview' });
    const card = el('div', { class: 'rcpt-card' });
    preview.append(card);
    const previewWrap = el('div', { class: 'rcpt-preview-wrap' }, [preview]);

    function renderCard() {
      const colors = PAPERS[state.paper];
      const rows = buildRows(data);
      const ph = paperHeight(rows);
      const scale = Math.min(1, (CARD_H - 60) / ph);

      card.innerHTML = '';
      // Background layer by type. Blur applies ONLY to the poster background.
      const myToken = ++renderToken;
      const bg = el('div', { class: 'rcpt-bg' });
      if (state.bgType === 'poster' && state.posterUrl) {
        posterBackgroundCss(state.posterUrl, BLURS[state.blur][1]).then((css) => {
          if (myToken === renderToken) bg.style.backgroundImage = css;
        });
      } else if (state.bgType === 'gradient') {
        bg.style.backgroundImage = gradientCss(GRADIENTS[state.gradient]);
      } else {
        bg.style.backgroundColor = state.color;
      }

      // Paper with torn edges + thermal texture (drawn on top of the background).
      const pts = tornPoints(PAPER_W, ph);
      const clip = 'polygon(' + pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(', ') + ')';
      const paper = el('div', {
        class: `rcpt-paper rcpt-paper-${state.paper}`,
        style: {
          width: `${PAPER_W}px`,
          height: `${ph}px`,
          background: colors.bg,
          clipPath: clip,
          WebkitClipPath: clip,
          paddingTop: `${PAD_Y}px`,
          left: `${(CARD_W - PAPER_W * scale) / 2}px`,
          top: `${(CARD_H - ph * scale) / 2}px`,
          transform: `scale(${scale})`,
        },
      });
      const inner = el('div', { style: { position: 'relative', zIndex: '1', padding: `0 ${PAD_X}px` } });
      for (const r of rows) inner.append(htmlRow(r, colors));
      paper.append(inner);
      card.append(bg, paper);
    }

    function fit() {
      // The sheet's close() only removes the backdrop, so this resize listener
      // would otherwise outlive every receipt and pin its detached DOM. Once the
      // preview is gone, unregister so it can't leak or run stale layout passes.
      if (!previewWrap.isConnected) {
        window.removeEventListener('resize', fit);
        return;
      }
      const availW = previewWrap.clientWidth || 1;
      const maxH = Math.max(220, window.innerHeight * 0.4);
      const s = Math.min(availW / CARD_W, maxH / CARD_H);
      card.style.transform = `scale(${s})`;
      // Container matches the scaled card exactly → no black bars.
      preview.style.width = `${CARD_W * s}px`;
      preview.style.height = `${CARD_H * s}px`;
    }

    // --- Background picker ----------------------------------------------------
    const pickerArea = el('div', { class: 'rcpt-picker' });
    const selButtons = {};

    // Each selector circle shows only its own preview (colour / gradient / poster
    // thumbnail) — no default background or border. Only the ACTIVE one gets the
    // accent border, so all three read consistently.
    function buildSelectorRow() {
      const mk = (type, label, fill) => {
        const circle = el('div', { class: 'rcpt-sel-circle' });
        fill(circle);
        const btn = el('button', { class: 'rcpt-sel' + (state.bgType === type ? ' active' : '') }, [
          circle,
          el('div', { class: 'rcpt-sel-label', text: label }),
        ]);
        btn.addEventListener('click', () => selectType(type));
        selButtons[type] = btn;
        return btn;
      };
      const colorBtn = mk('color', t('receipt.bg.color'), (c) => { c.style.background = state.color; });
      const gradBtn = mk('gradient', t('receipt.bg.gradient'), (c) => {
        c.style.backgroundImage = gradientCss(GRADIENTS[state.gradient]);
        c.style.backgroundSize = '100% 100%'; // gradients have no intrinsic size → fill exactly (round)
      });
      const posterBtn = mk('poster', t('receipt.bg.poster'), (c) => {
        if (backgrounds.length) imageCache.load(backgrounds[0].poster_url).then((u) => { c.style.backgroundImage = `url("${u}")`; });
        else c.append(lucideIcon('image', 'rcpt-sel-ico'));
      });

      // Blur control: sits at the end of the row after a thin divider. It's only
      // usable when Poster is the active background; otherwise it's visibly
      // disabled (dimmed, non-tappable).
      const blurBtn = el('button', { class: 'rcpt-sel rcpt-blur-btn', 'aria-label': t('receipt.bg.blur') }, [
        el('div', { class: 'rcpt-sel-circle rcpt-blur-circle' }, [lucideIcon('droplet', 'rcpt-sel-ico')]),
        el('div', { class: 'rcpt-sel-label', text: t('receipt.bg.blur') }),
      ]);
      blurBtn.addEventListener('click', () => {
        if (state.bgType !== 'poster') return; // disabled unless poster is active
        state.blurOpen = !state.blurOpen;
        updateBlurBtn();
        fadeSwapPicker(); // blur options replace the poster row (and vice-versa)
      });
      selButtons.blur = blurBtn;
      updateBlurBtn();

      return el('div', { class: 'rcpt-selector-row' }, [
        colorBtn,
        gradBtn,
        posterBtn,
        el('div', { class: 'rcpt-sel-divider' }),
        blurBtn,
      ]);
    }

    function updateBlurBtn() {
      const b = selButtons.blur;
      if (!b) return;
      const enabled = state.bgType === 'poster';
      b.classList.toggle('disabled', !enabled);
      b.classList.toggle('active', enabled && (state.blurOpen || state.blur > 0));
    }

    // Gentle fade between picker contents (colours ↔ gradients ↔ posters ↔ blur).
    function fadeSwapPicker() {
      pickerArea.classList.add('fading');
      setTimeout(() => {
        renderPicker();
        pickerArea.classList.remove('fading');
      }, 160);
    }

    function selectType(type) {
      if (state.bgType === type) return;
      state.bgType = type;
      // Leaving the poster collapses the blur control and resets its value.
      if (type !== 'poster') {
        state.blurOpen = false;
        state.blur = 0;
      }
      for (const t of ['color', 'gradient', 'poster']) {
        if (selButtons[t]) selButtons[t].classList.toggle('active', t === type);
      }
      updateBlurBtn();
      fadeSwapPicker();
      renderCard();
      fit();
    }

    function renderPicker() {
      pickerArea.innerHTML = '';
      if (state.bgType === 'color') {
        const row = el('div', { class: 'rcpt-swatches' });
        COLORS.forEach((hex) => {
          const sw = el('button', { class: 'rcpt-swatch' + (state.color === hex ? ' active' : ''), style: { background: hex }, title: hex });
          sw.addEventListener('click', () => {
            state.color = hex;
            const c = selButtons.color && selButtons.color.querySelector('.rcpt-sel-circle');
            if (c) c.style.background = hex; // keep the selector preview in sync
            renderPicker();
            renderCard();
            fit();
          });
          row.append(sw);
        });
        pickerArea.append(row);
      } else if (state.bgType === 'gradient') {
        const row = el('div', { class: 'rcpt-swatches' });
        GRADIENTS.forEach((g, i) => {
          const sw = el('button', {
            class: 'rcpt-swatch' + (state.gradient === i ? ' active' : ''),
            style: { backgroundImage: gradientCss(g), backgroundSize: '100% 100%' },
            title: t(g.nameKey),
          });
          sw.addEventListener('click', () => {
            state.gradient = i;
            const c = selButtons.gradient && selButtons.gradient.querySelector('.rcpt-sel-circle');
            if (c) {
              c.style.backgroundImage = gradientCss(g); // keep the selector preview in sync
              c.style.backgroundSize = '100% 100%';
            }
            renderPicker();
            renderCard();
            fit();
          });
          row.append(sw);
        });
        pickerArea.append(row);
      } else if (state.blurOpen) {
        // Blur intensity options replace the poster row (like colours/gradients):
        // full-width rounded-rectangle cells with an icon row on top and label
        // under. "Off" keeps the droplet-off glyph; Light/Medium/Heavy repeat a
        // smaller droplet 1/2/3 times on one row, so the count itself reads the
        // level.
        const opts = el('div', { class: 'rcpt-blur-opts', style: { gridTemplateColumns: `repeat(${BLURS.length}, 1fr)` } });
        BLURS.forEach((b, i) => {
          const iconRow = el('div', { class: 'rcpt-blur-opt-icons' });
          if (i === 0) {
            iconRow.append(lucideIcon('droplet-off', 'rcpt-blur-opt-ico'));
          } else {
            for (let k = 0; k < i; k++) {
              iconRow.append(lucideIcon('droplet', 'rcpt-blur-opt-ico rcpt-blur-opt-ico-sm'));
            }
          }
          const cell = el('button', { class: 'rcpt-blur-opt' + (state.blur === i ? ' active' : '') }, [
            iconRow,
            el('span', { class: 'rcpt-blur-opt-label', text: t(b[0]) }),
          ]);
          cell.addEventListener('click', () => {
            state.blur = i;
            if (i === 0) state.blurOpen = false; // back to the poster row
            updateBlurBtn();
            fadeSwapPicker();
            renderCard();
            fit();
          });
          opts.append(cell);
        });
        pickerArea.append(opts);
      } else {
        const scroller = el('div', { class: 'rcpt-bg-scroller' });
        if (!backgrounds.length) {
          scroller.append(el('div', { class: 'muted', text: t('receipt.noTitles') }));
        }
        backgrounds.forEach((p) => {
          const thumb = el('button', { class: 'rcpt-bg-thumb' + (state.posterUrl === p.poster_url ? ' active' : ''), title: p.title });
          imageCache.load(p.poster_url).then((u) => { thumb.style.backgroundImage = `url("${u}")`; });
          thumb.addEventListener('click', () => { state.posterUrl = p.poster_url; renderPicker(); renderCard(); fit(); });
          scroller.append(thumb);
        });
        pickerArea.append(scroller);
      }
    }

    function build() {
      body.innerHTML = '';
      renderCard();
      body.append(previewWrap, buildSelectorRow(), el('hr', { class: 'status-sep' }), pickerArea);
      renderPicker();
      fit();
      requestAnimationFrame(fit);
      // Swap Courier → the custom font in the preview once it has loaded.
      ensureReceiptFont().then(() => {
        if (previewWrap.isConnected) {
          renderCard();
          fit();
        }
      });
    }

    // --- Export: redraw the identical layout at 1080×1920 and download ------
    async function exportImage(btn) {
      btn.disabled = true;
      const label = btn.textContent;
      setLabel(btn, t('receipt.rendering'));
      try {
        await ensureReceiptFont(); // canvas silently falls back unless it's loaded
        const cdImg = await loadImage(LOGO_URL);
        const bgImg = state.bgType === 'poster' && state.posterUrl ? await loadImage(state.posterUrl) : null;
        const canvas = document.createElement('canvas');
        canvas.width = CARD_W * EXPORT_SCALE;
        canvas.height = CARD_H * EXPORT_SCALE;
        const ctx = canvas.getContext('2d');
        // Supersample: scale the whole context so every design-space coordinate
        // (CARD_W/CARD_H, PAPER_W, fonts…) below renders at EXPORT_SCALE× density.
        ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

        // Background by type (poster pixel-blurred when set — same path as the
        // preview, iOS-safe).
        if (state.bgType === 'poster' && bgImg) {
          const b = BLURS[state.blur][1];
          if (b) {
            ctx.drawImage(makeBlurredCanvas(bgImg, b), 0, 0, CARD_W, CARD_H);
          } else {
            const s = Math.max(CARD_W / bgImg.width, CARD_H / bgImg.height);
            const w = bgImg.width * s;
            const h = bgImg.height * s;
            ctx.drawImage(bgImg, (CARD_W - w) / 2, (CARD_H - h) / 2, w, h);
          }
        } else if (state.bgType === 'gradient') {
          drawGradient(ctx, GRADIENTS[state.gradient], CARD_W, CARD_H);
        } else {
          ctx.fillStyle = state.color;
          ctx.fillRect(0, 0, CARD_W, CARD_H);
        }

        // Paper (scaled + centred exactly like the preview).
        const colors = PAPERS[state.paper];
        const rows = buildRows(data);
        const ph = paperHeight(rows);
        const scale = Math.min(1, (CARD_H - 60) / ph);
        ctx.save();
        ctx.translate((CARD_W - PAPER_W * scale) / 2, (CARD_H - ph * scale) / 2);
        ctx.scale(scale, scale);
        ctx.beginPath();
        tornPoints(PAPER_W, ph).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 46;
        ctx.shadowOffsetY = 14;
        ctx.fillStyle = colors.bg;
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.clip(); // keep the text inside the torn shape
        canvasRows(ctx, rows, colors, cdImg);
        ctx.restore();

        const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
        if (!blob) throw new Error(t('receipt.exportFailed'));
        const fname = `${data.store_name.toLowerCase()}-${data.month_name.toLowerCase()}-${data.year}.jpg`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fname;
        document.body.append(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 1000);
        toast(t('receipt.saved'), 'ok');
      } catch (err) {
        toast(err.message || t('receipt.exportError'), 'bad');
      } finally {
        btn.disabled = false;
        setLabel(btn, label);
      }
    }

    window.addEventListener('resize', fit, { passive: true });
  });
}
