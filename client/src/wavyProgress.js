// Reusable wavy progress bar (self-contained inline SVG, no deps, reusable).
//
// The ELAPSED portion is a THICK sinusoidal wave, clipped to the elapsed width
// via a <clipPath> whose width advances (smooth CSS transition). The wave PHASE
// crawls rightward via a CSS @keyframes — this crawl is the only motion, and it
// only shows inside the clipped (elapsed) region. The REMAINING portion is a
// THIN, static line at 20% opacity, and a dot marks the boundary. There is NO
// animation along the full length of the bar.
//
//   const bar = createWavyProgress();
//   container.append(bar.el);
//   bar.setProgress(0.35); // 0..1
//
// All wave / stroke parameters are named constants at the top.
const VIEW_W = 400; // internal coordinate width (stretched to the container width)
const HEIGHT = 18; // tall enough to show the wave amplitude without clipping
const AMPLITUDE = 3.2; // wave height (perpendicular)
const WAVELENGTH = 20; // px between crests
const FILLED_STROKE = 7; // thick elapsed wave (6–8)
const TRACK_STROKE = 2; // thin remaining line
const KODI_BLUE = '#17B2E8';
const TRACK_COLOR = 'rgba(23, 178, 232, 0.2)'; // Kodi blue @ 20%

let uidSeq = 0;

export function createWavyProgress(opts = {}) {
  const color = opts.color || KODI_BLUE;
  const cy = HEIGHT / 2;
  const uid = `wavyprog-${uidSeq++}`;

  // Sine path drawn a wavelength wider on each side so the crawl (a −WAVELENGTH
  // translate) never reveals a gap at the clip edge.
  let d = '';
  for (let x = -WAVELENGTH; x <= VIEW_W + WAVELENGTH; x += 2) {
    const y = cy + AMPLITUDE * Math.sin((2 * Math.PI * x) / WAVELENGTH);
    d += `${x === -WAVELENGTH ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(2)} `;
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none'); // stretch horizontally to fill
  svg.classList.add('wavyprog');
  svg.style.height = `${HEIGHT}px`;
  svg.style.setProperty('--wl', `${WAVELENGTH}px`);
  svg.innerHTML =
    `<defs><clipPath id="${uid}"><rect class="wavyprog-clip" x="0" y="0" width="0" height="${HEIGHT}"/></clipPath></defs>` +
    // Thin static remaining line (full width; the thick wave covers the elapsed part).
    `<line class="wavyprog-track" x1="0" y1="${cy}" x2="${VIEW_W}" y2="${cy}" stroke="${TRACK_COLOR}" stroke-width="${TRACK_STROKE}" stroke-linecap="round"/>` +
    // Thick crawling wave, clipped to the elapsed width.
    `<g clip-path="url(#${uid})"><path class="wavyprog-wave" d="${d}" fill="none" stroke="${color}" stroke-width="${FILLED_STROKE}" stroke-linecap="round"/></g>` +
    // Boundary dot.
    `<circle class="wavyprog-dot" cx="0" cy="${cy}" r="${FILLED_STROKE / 2}" fill="${color}"/>`;

  const clip = svg.querySelector('.wavyprog-clip');
  const dot = svg.querySelector('.wavyprog-dot');

  function setProgress(frac) {
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    const x = f * VIEW_W;
    // Set via CSS style so the clip width + dot advance smoothly (see styles.css).
    clip.style.width = `${x.toFixed(1)}px`;
    dot.style.cx = `${x.toFixed(1)}px`;
  }
  setProgress(0);

  return { el: svg, setProgress };
}
