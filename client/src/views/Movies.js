// Movies screen (/movies) — a thin wrapper that renders the shared filtered
// poster grid (see grid.js) for the 'movie' section.

import { gridView } from './grid.js';

export default async function Movies(container) {
  return gridView(container, 'movie');
}
