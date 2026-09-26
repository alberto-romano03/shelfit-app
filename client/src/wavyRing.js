// Animated wavy ring around the profile avatar (Kodi "Now Playing").
//
// A circular PROGRESS indicator, NOT a spinner — there is NO rotation of any
// kind. Two complementary arcs together form (nearly) a full circle, sized
// LARGER than the avatar so neither overlaps the avatar's own border:
//   • filled (elapsed): a THICK wavy stroke following the circle, the sine wave
//     applied radially (in/out from the base radius). Bright Kodi blue, opaque.
//     It grows clockwise from 12 o'clock. The wave PHASE crawls continuously
//     (a rAF loop recomputes the path) — this is the only motion.
//   • unfilled (remaining): a SMOOTH static arc of the SAME thickness, on the
//     same base radius, in a darker Kodi blue (opaque). Inset by a small gap at
//     each end so it never touches the wave's start/end.
//   • the two ends of the wave are identical round-capped tips (no dot).
//
// All wave/stroke parameters are named constants below. Vanilla JS <path>, no
// SVG animation library.
const OSCILLATIONS = 14; // wave crests around a full circle (6–8 = organic)
const AMPLITUDE = 0.8; // radial wave height — bold, clearly-visible bumps
const FILLED_STROKE = 4; // filled arc (Arc 1)
const TRACK_STROKE = 4; // remaining arc (Arc 2) — SAME thickness as the wave, on the same radius
const TRACK_GAP_FRAC = 0.03; // gap between track and each wave end, as a fraction of the full circle
const PHASE_SPEED = 2; // wave crawl, radians/second
const PROGRESS_EASE = 5; // how fast the drawn progress approaches the target (per s)
const VIEW = 100; // viewBox size
const RADIUS = 42; // base ring radius
const STEPS_PER_TURN = 260; // path resolution for a full circle
const KODI_BLUE = '#17B2E8';
const TRACK_COLOR = 'rgba(13, 131, 210, 0.4)'; // remaining ring — darker Kodi blue

export function createWavyRing(opts = {}) {
  const color = opts.color || KODI_BLUE;
  const c = VIEW / 2;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW} ${VIEW}`);
  svg.classList.add('kodi-ring');
  svg.setAttribute('aria-hidden', 'true');
  // Two complementary arcs that together form one ring around the avatar:
  //   Arc 2 (track): a smooth, static, darker arc over the UNFILLED portion.
  //   Arc 1 (wave):  a wavy, bright, animated arc over the FILLED portion.
  // Same thickness, same base radius. Both are explicit <path>s built from the
  // SAME point() helper, so they can never overlap or hide each other.
  svg.innerHTML =
    `<path class="kodi-ring-track" fill="none" stroke="${TRACK_COLOR}" stroke-width="${TRACK_STROKE}" stroke-linecap="round"/>` +
    `<path class="kodi-ring-arc" fill="none" stroke="${color}" stroke-width="${FILLED_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`;

  const track = svg.querySelector('.kodi-ring-track');
  const arc = svg.querySelector('.kodi-ring-arc');

  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let target = 0; // requested progress (0..1)
  let cur = 0; // drawn progress (eased toward target)
  let phase = 0; // wave crawl phase
  let active = false;
  let raf = null;
  let last = null;

  // Point on the circle at clockwise angle θ (0 = 12 o'clock), at radius r.
  function point(theta, r) {
    return [c + r * Math.sin(theta), c - r * Math.cos(theta)];
  }

  function draw() {
    const end = cur * Math.PI * 2; // boundary angle between the two arcs

    // Arc 2 (track): smooth constant-radius arc over the UNFILLED portion —
    // from the boundary (end) clockwise back up to 12 o'clock (2π). No wave.
    // Inset by TRACK_GAP at BOTH ends so it never touches the wave's start/end.
    const gap = TRACK_GAP_FRAC * Math.PI * 2; // angular gap at each end
    const tFrom = end + gap;
    const tTo = Math.PI * 2 - gap;
    if (tTo > tFrom) {
      const uSteps = Math.max(2, Math.ceil(STEPS_PER_TURN * ((tTo - tFrom) / (Math.PI * 2))));
      let td = '';
      for (let i = 0; i <= uSteps; i++) {
        const th = tFrom + (i / uSteps) * (tTo - tFrom);
        const [x, y] = point(th, RADIUS);
        td += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)} `;
      }
      track.setAttribute('d', td);
    } else {
      track.setAttribute('d', '');
    }

    if (cur <= 0.0005) {
      arc.setAttribute('d', '');
      return;
    }
    // Arc 1 (wave): thick wavy arc over the FILLED portion, θ from 0 to end.
    // Both ends are identical round-capped wave tips (no boundary dot).
    const steps = Math.max(2, Math.ceil(STEPS_PER_TURN * cur));
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const th = (i / steps) * end;
      // --- Wavy elapsed arc (commented out — uncomment to bring the wave back) ---
      const r = RADIUS + AMPLITUDE * Math.sin(OSCILLATIONS * th + phase);
      // --- Smooth elapsed arc (current) — same shape as the complementary track ---
      // const r = RADIUS;
      const [x, y] = point(th, r);
      d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)} `;
    }
    arc.setAttribute('d', d);
  }

  function frame(ts) {
    if (!svg.isConnected || !active) {
      raf = null;
      last = null;
      return;
    }
    if (last == null) last = ts;
    let dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.05) dt = 0.05; // clamp big gaps (backgrounded tab)
    if (!reduce) phase += PHASE_SPEED * dt; // crawl
    // Ease the drawn progress toward the target → a smooth boundary advance.
    cur += (target - cur) * Math.min(1, PROGRESS_EASE * dt);
    if (Math.abs(target - cur) < 0.0005) cur = target;
    draw();
    raf = requestAnimationFrame(frame);
  }
  function ensureLoop() {
    if (active && raf == null) {
      last = null;
      raf = requestAnimationFrame(frame);
    }
  }

  function setProgress(f) {
    target = Math.max(0, Math.min(1, Number(f) || 0));
    if (reduce) {
      cur = target;
      draw();
    } else {
      ensureLoop();
    }
  }
  function setActive(on) {
    active = !!on;
    svg.classList.toggle('active', active);
    if (active) ensureLoop();
    else if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  }
  draw();

  return { el: svg, setProgress, setActive };
}
