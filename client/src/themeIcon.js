// The sun and moon of the Home theme button are one drawing: the disc reshapes into the
// moon (the same five curves in different places) and the rays turn away.
//
// Every frame is written from here rather than left to CSS. Safari can't animate a path's
// `d`, so the disc would snap there while only the rays moved, and SVG attributes draw the
// same in every browser.

const SUN = 'M12 8C13.061 8 14.078 8.422 14.828 9.172C15.578 9.922 16 10.939 16 12C16 14.209 14.209 16 12 16C9.791 16 8 14.209 8 12C8 9.791 9.791 8 12 8Z';
const MOON = 'M11.2 3C9.11 5.787 9.387 9.687 11.85 12.15C14.313 14.613 18.213 14.89 21 12.8C20.556 17.53 16.506 21.105 11.757 20.956C7.008 20.807 3.194 16.992 3.045 12.243C2.896 7.494 6.463 3.447 11.2 3Z';
const RAYS = 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4';
const MORPH_MS = 600; // as long as the page's reveal (theme.js)
// Past this far toward the moon the rays are gone. They sit just outside the shrinking
// disc, so they are never drawn across it, in either direction.
const RAYS_GONE_AT = 0.45;

const numbers = (d) => d.match(/-?[\d.]+/g).map(Number);
const SUN_N = numbers(SUN);
const MOON_N = numbers(MOON);

// --ease-in-out, cubic-bezier(0.4, 0, 0.2, 1).
function easeInOut(x) {
  let lo = 0;
  let hi = 1;
  let s = x;
  for (let i = 0; i < 12; i++) {
    const at = 3 * (1 - s) * (1 - s) * s * 0.4 + 3 * (1 - s) * s * s * 0.2 + s * s * s;
    if (at < x) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return 3 * (1 - s) * s * s + s * s * s;
}

function discAt(p) {
  const n = SUN_N.map((v, i) => +(v + (MOON_N[i] - v) * p).toFixed(3));
  let d = `M${n[0]} ${n[1]}`;
  for (let i = 2; i < n.length; i += 6) d += `C${n.slice(i, i + 6).join(' ')}`;
  return `${d}Z`;
}

// { el, to(moon) }: the icon, and the move to the moon (true) or the sun (false). A second
// tap mid-move carries on from where the drawing is.
export function themeIcon(moon) {
  const holder = document.createElement('div');
  holder.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${RAYS}"/><path/></svg>`;
  const svg = holder.firstChild;
  const [rays, disc] = svg.children;

  let at = moon ? 1 : 0; // 0 the sun, 1 the moon
  let frame = 0;
  function draw(p) {
    at = p;
    disc.setAttribute('d', discAt(p));
    rays.setAttribute('opacity', Math.max(0, 1 - p / RAYS_GONE_AT).toFixed(3));
    rays.setAttribute(
      'transform',
      `translate(12 12) rotate(${(45 * p).toFixed(2)}) scale(${(1 - 0.4 * p).toFixed(3)}) translate(-12 -12)`
    );
  }
  draw(at);

  function to(toMoon) {
    const target = toMoon ? 1 : 0;
    cancelAnimationFrame(frame);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      draw(target);
      return;
    }
    const from = at;
    let start = 0;
    const step = (now) => {
      start = start || now;
      const t = Math.min(1, (now - start) / MORPH_MS);
      draw(from + (target - from) * easeInOut(t));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  return { el: svg, to };
}
