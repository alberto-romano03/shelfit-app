// Series screen (/series) — a thin wrapper that renders the shared filtered
// poster grid (see grid.js) for the 'show' section.

import { gridView } from './grid.js';

export default async function Series(container) {
  return gridView(container, 'show');
}
