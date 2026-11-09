// "Stopped at": the minute a movie or an episode was left at (see migration 8).

// The minute from a request body: a whole minute 1-999, or null to clear it
// (0, null or ''). undefined when the value is neither, so the route can refuse it.
export function stopMinute(v) {
  if (v === null || v === '' || v === 0 || v === '0') return null;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 && n <= 999 ? n : undefined;
}
