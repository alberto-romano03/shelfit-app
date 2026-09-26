// Confetti celebration — a self-contained, reusable burst fired with a single
// call: confetti.trigger(). A fixed pool of absolutely-positioned pieces is
// created once and recycled across triggers; the overlay is pointer-events:none
// and is detached from the DOM entirely between celebrations, so nothing lingers.
// Motion is driven by one requestAnimationFrame loop (transform + opacity only —
// no per-piece CSS keyframes, no layout/paint churn), keeping it smooth at 60fps.

const PIECE_COUNT = 90;
const DURATION_MS = 3500; // ~3.5s from first piece to last fade
// App accent palette plus celebratory gold / white.
const COLORS = ['#e5a00d', '#ffd700', '#ffffff', '#ff6b6b', '#4ecdc4', '#8e7dff'];

const rand = (min, max) => Math.random() * (max - min) + min;

let overlay = null;
let pieces = null; // fixed pool of { el, x, y, vx, vy, rot, vrot }
let running = false;
let startTime = 0;
let rafId = 0;

function buildPool() {
  overlay = document.createElement('div');
  overlay.className = 'confetti-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  pieces = [];
  for (let i = 0; i < PIECE_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    overlay.append(el);
    pieces.push({ el, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vrot: 0 });
  }
}

function resetPiece(p, W, H) {
  p.x = rand(0, W);
  p.y = rand(-H * 0.6, -10); // start above the viewport, staggered so it cascades
  p.vx = rand(-0.7, 0.7);
  p.vy = rand(2.4, 5.4);
  p.rot = rand(0, 360);
  p.vrot = rand(-9, 9);
  const size = rand(6, 12);
  const circle = Math.random() < 0.35;
  const el = p.el;
  el.style.width = `${size}px`;
  el.style.height = circle ? `${size}px` : `${(size * 0.5).toFixed(1)}px`;
  el.style.background = COLORS[(Math.random() * COLORS.length) | 0];
  el.style.borderRadius = circle ? '50%' : '1px';
  el.style.opacity = '1';
  el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) rotate(${p.rot}deg)`;
}

function frame(now) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const fadeFrom = H * 0.65; // pieces fade across the lower third — never pile up
  const dt = Math.min(2, (now - (frame._last || now)) / 16.67); // frames elapsed, capped
  frame._last = now;

  for (const p of pieces) {
    p.vy += 0.03 * dt; // gentle gravity
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vrot * dt;
    const op = p.y > fadeFrom ? Math.max(0, 1 - (p.y - fadeFrom) / (H * 0.35)) : 1;
    p.el.style.opacity = String(op);
    p.el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) rotate(${p.rot}deg)`;
  }

  if (now - startTime < DURATION_MS) {
    rafId = requestAnimationFrame(frame);
  } else {
    running = false;
    frame._last = 0;
    if (overlay) overlay.remove(); // detached — nothing lingers in the DOM
  }
}

export const confetti = {
  trigger() {
    if (typeof document === 'undefined') return;
    if (!pieces) buildPool();
    if (!overlay.isConnected) document.body.append(overlay);
    const W = window.innerWidth;
    const H = window.innerHeight;
    for (const p of pieces) resetPiece(p, W, H);
    startTime = performance.now(); // (re)start the clock — re-triggers run fully
    if (!running) {
      running = true;
      frame._last = 0;
      rafId = requestAnimationFrame(frame);
    }
  },
};
