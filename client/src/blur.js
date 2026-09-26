// Pure-JS separable box blur for canvas ImageData. Three passes approximate a
// Gaussian. It only reads/writes pixel arrays — no CSS or canvas `filter` — so
// it works everywhere, including iOS Safari (which does not honour `filter` on a
// layer inside a transformed, overflow-hidden container, nor `ctx.filter` on
// older versions). Edges are clamped, so there is no transparent halo.

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Blur along x within each row: src -> dst (RGB; alpha copied through).
function blurH(src, dst, w, h, r) {
  const div = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w * 4;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[o + clamp(i, 0, w - 1) * 4 + c];
      for (let x = 0; x < w; x++) {
        dst[o + x * 4 + c] = sum / div;
        sum +=
          src[o + clamp(x + r + 1, 0, w - 1) * 4 + c] -
          src[o + clamp(x - r, 0, w - 1) * 4 + c];
      }
    }
    for (let x = 0; x < w; x++) dst[o + x * 4 + 3] = src[o + x * 4 + 3];
  }
}

// Blur along y within each column: src -> dst.
function blurV(src, dst, w, h, r) {
  const div = r * 2 + 1;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += src[(clamp(i, 0, h - 1) * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        dst[(y * w + x) * 4 + c] = sum / div;
        sum +=
          src[(clamp(y + r + 1, 0, h - 1) * w + x) * 4 + c] -
          src[(clamp(y - r, 0, h - 1) * w + x) * 4 + c];
      }
    }
    for (let y = 0; y < h; y++) dst[(y * w + x) * 4 + 3] = src[(y * w + x) * 4 + 3];
  }
}

// Blur `imageData` in place by `radius` px (3 passes ≈ Gaussian).
export function boxBlur(imageData, radius, passes = 3) {
  const r = Math.round(radius);
  if (r < 1) return imageData;
  const { data, width: w, height: h } = imageData;
  const a = data;
  const b = new Uint8ClampedArray(data.length);
  for (let p = 0; p < passes; p++) {
    blurH(a, b, w, h, r); // a -> b
    blurV(b, a, w, h, r); // b -> a (result lands back in `data`)
  }
  return imageData;
}
