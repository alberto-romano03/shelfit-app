// A poster's main colour, as a hue. Worked out once from a tiny copy of the image and
// remembered, so a page that has seen a poster can paint with its colour straight away.
// A poster with almost no colour (black and white, near-grey) has no hue, and callers keep
// what they had.

import { imageCache } from './imageCache.js';

const KEY = 'shelfit:poster-hues';
const MAX_SAVED = 800;
const NO_HUE = -1;

let saved = null;
function store() {
  if (saved) return saved;
  try {
    saved = JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    saved = {};
  }
  return saved;
}
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(KEY, JSON.stringify(store()));
  } catch {
    /* full or blocked: it just gets worked out again next time */
  }
}
// A shelf can teach several at once, so the write waits for a pause.
function remember(url, hue) {
  const s = store();
  s[url] = hue;
  const keys = Object.keys(s);
  if (keys.length > MAX_SAVED) delete s[keys[0]];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1500);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) save();
});

// The strongest band of hues, ignoring greys and near-black. Null when too little of the
// image has any colour.
function hueOf(img) {
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 36;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, 24, 36);
  const d = x.getImageData(0, 0, 24, 36).data;
  const bands = new Array(36).fill(0);
  let coloured = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255;
    const g = d[i + 1] / 255;
    const b = d[i + 2] / 255;
    const max = Math.max(r, g, b);
    const range = max - Math.min(r, g, b);
    if (range < 0.18 || max < 0.2) continue;
    let h = max === r ? ((g - b) / range) % 6 : max === g ? (b - r) / range + 2 : (r - g) / range + 4;
    h = (h * 60 + 360) % 360;
    bands[Math.floor(h / 10)] += range;
    coloured += 1;
  }
  if (coloured < (24 * 36) / 12) return null;
  return bands.indexOf(Math.max(...bands)) * 10 + 5;
}

// undefined: not worked out yet. null: this poster has no colour to use.
export function savedPosterHue(url) {
  const h = store()[url];
  if (h === undefined) return undefined;
  return h === NO_HUE ? null : h;
}

export async function posterHue(url) {
  const known = savedPosterHue(url);
  if (known !== undefined) return known;
  const src = await imageCache.load(url);
  if (!src) return null;
  const img = new Image();
  img.src = src;
  await img.decode();
  let hue = null;
  try {
    hue = hueOf(img);
  } catch {
    return null; // an image the canvas may not read; not worth remembering
  }
  remember(url, hue === null ? NO_HUE : hue);
  return hue;
}

// The tile a poster loads over: the tour's posters (.sc-wall .sc-poster), a strong colour
// into a much darker one of nearly the same hue, in this poster's colour. A poster with no
// colour to speak of gets the same shape in grey. Null until its colour is known.
export function tileFor(url) {
  const h = url ? savedPosterHue(url) : undefined;
  if (h === undefined) return null;
  if (h === null) return 'linear-gradient(150deg, hsl(0 0% 38%), hsl(0 0% 17%))';
  return `linear-gradient(150deg, hsl(${h} 70% 41%), hsl(${(h + 356) % 360} 68% 22%))`;
}

// Note a poster's colour from the image already on screen, so it costs no extra request.
// One at a time and when idle, never in the way of a scroll. A grid recycles its images, so
// one that has moved on to another poster by then is skipped.
const learning = [];
let learnScheduled = false;
const whenIdle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200));
function learnNext() {
  learnScheduled = false;
  const job = learning.shift();
  if (!job) return;
  const { url, img, src } = job;
  if (img.getAttribute('src') === src && img.naturalWidth > 0 && savedPosterHue(url) === undefined) {
    try {
      const hue = hueOf(img);
      remember(url, hue === null ? NO_HUE : hue);
    } catch {
      /* an image the canvas may not read */
    }
  }
  if (learning.length) scheduleLearning();
}
function scheduleLearning() {
  if (learnScheduled) return;
  learnScheduled = true;
  whenIdle(learnNext);
}
export function learnPosterHue(url, img) {
  if (!url || !img || savedPosterHue(url) !== undefined) return;
  if (learning.length >= 40) learning.shift();
  learning.push({ url, img, src: img.getAttribute('src') });
  scheduleLearning();
}

function luminance(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
}

// The three tile colours for a hue. The middle one carries white text, so it darkens until
// that passes 4.5:1, which yellows need and blues don't.
export function tilesForHue(h) {
  let mid = 42;
  while (mid > 24 && 1.05 / (luminance(h, 0.52, mid / 100) + 0.05) < 4.5) mid -= 1;
  return {
    dark: `hsl(${h} 38% 17%)`,
    mid: `hsl(${h} 52% ${mid}%)`,
    light: `hsl(${h} 42% 90%)`,
    midText: '#fff',
  };
}
