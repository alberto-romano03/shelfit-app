// Seasonal snow — a small, recycled pool of CSS-animated flakes that fall inside
// the home cover during December only. No JS runs per frame: each flake loops an
// infinite CSS @keyframes with per-flake randomized size, opacity, speed, delay
// and horizontal drift, so the field feels organic and non-repetitive. Entirely
// absent (zero DOM, zero work) in every other month or when the user disables it.

import { getPref } from './prefs.js';

const FLAKE_COUNT = 18; // conservative — atmospheric, not distracting or heavy

function isDecember() {
  return new Date().getMonth() === 11; // 0-based month: 11 = December
}

const rand = (min, max) => Math.random() * (max - min) + min;

// Attach the snow layer to `coverEl` and return a cleanup function that removes
// it. A no-op (with a no-op cleanup) outside December, when disabled, or under
// reduced-motion — so there is no trace and no overhead the rest of the year.
export function initSnow(coverEl) {
  if (!coverEl || !isDecember() || !getPref('snow')) return () => {};
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return () => {};
    }
  } catch {
    /* matchMedia unavailable — proceed */
  }

  const layer = document.createElement('div');
  layer.className = 'snow-layer';
  layer.setAttribute('aria-hidden', 'true');

  for (let i = 0; i < FLAKE_COUNT; i++) {
    const f = document.createElement('div');
    f.className = 'snowflake';
    const size = rand(2, 5).toFixed(1);
    f.style.width = `${size}px`;
    f.style.height = `${size}px`;
    f.style.left = `${rand(0, 100).toFixed(2)}%`;
    // Per-flake CSS variables consumed by the @keyframes (drift + peak opacity).
    f.style.setProperty('--snow-drift', `${rand(-18, 18).toFixed(1)}px`);
    f.style.setProperty('--snow-opacity', rand(0.4, 0.9).toFixed(2));
    f.style.animationDuration = `${rand(6, 12).toFixed(1)}s`;
    // Negative delay pre-fills the animation, so flakes are mid-fall at mount.
    f.style.animationDelay = `${(-rand(0, 12)).toFixed(1)}s`;
    layer.append(f);
  }

  coverEl.append(layer);
  return () => layer.remove();
}
