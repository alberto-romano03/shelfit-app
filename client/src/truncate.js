// Smart description truncation — produces a natural, readable short preview of a
// long description. Pure (no DOM, no side effects), so it can be reused anywhere
// descriptions appear.
//
// Rules, applied in order:
//   1. Prefer to end at the first sentence boundary ('.', '!' or '?' followed by
//      a space or end of string) at or after `min` characters.
//   2. If that boundary is beyond `max`, hard-cut at `max` on the nearest word
//      boundary before it and append an ellipsis — never cut mid-word.
//   3. If the whole text is shorter than `min`, return it in full (not truncated).
//   4. Never cut mid-sentence unless rule 2 (the max limit) forces it.
//
// Returns { text, truncated }. `truncated` is true when `text` is a shortened
// preview (i.e. a "Show more" affordance is warranted).
export function smartTruncate(input, { min = 150, max = 300 } = {}) {
  const text = String(input || '')
    .replace(/\s+/g, ' ')
    .trim();

  // Rule 3: shorter than the minimum → show it all.
  if (text.length <= min) return { text, truncated: false };

  // Rule 1: first sentence ending in [min, max] → cut there cleanly. If that
  // boundary is the text's own end, the whole thing shows (nothing truncated).
  const end = firstSentenceEnd(text, min);
  if (end !== -1 && end <= max) {
    return { text: text.slice(0, end).trim(), truncated: end < text.length };
  }

  // No usable sentence boundary within the max. If the whole text fits under the
  // max, show it in full (a single long sentence reads better whole)...
  if (text.length <= max) return { text, truncated: false };

  // ...otherwise Rule 2: hard-cut at the max, on the nearest word boundary.
  const window = text.slice(0, max);
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > 0 ? lastSpace : max;
  const clipped = text.slice(0, cut).replace(/[\s.,;:!?—–-]+$/, '');
  return { text: clipped + '…', truncated: true };
}

// Index just past the first sentence terminator ('.', '!' or '?' followed by a
// space or the end of the string) that lands at or after `min`. -1 if none.
function firstSentenceEnd(text, min) {
  const re = /[.!?](?=\s|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const endIdx = m.index + 1; // include the terminator
    if (endIdx >= min) return endIdx;
  }
  return -1;
}
