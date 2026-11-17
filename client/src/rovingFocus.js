// Keyboard reach for a virtualised grid or list (the Movies and Series grids,
// a season's episodes). Their cells are recycled while scrolling, so the order
// they sit in the page is not the order on screen, and plain Tab would jump
// around. So only one cell is in the Tab order at a time: the last one used, or
// the first in view. The arrow keys move from it by position, as in any grid;
// Enter and Space press it; Tab leaves the list.
//
//   const roving = rovingFocus(container, {
//     selector,              // the cells that take part
//     positionOf(node),      // { i, c } for a live cell, else null
//     nodeAt({ i, c }),      // the live cell at that position, else null
//     move({ i, c }, key),   // the position an arrow key leads to, else null
//     viewport,              // the scrolling box "in view" means (default: container)
//   });
//   roving.sync();           // after each render: re-picks the one in Tab order
export function rovingFocus(container, { selector, positionOf, nodeAt, move, viewport = container }) {
  let current = null; // the position last focused

  const inView = (n) => {
    const r = n.getBoundingClientRect();
    if (!r.height) return false;
    const box = viewport.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  };
  const before = (a, b) => a.i < b.i || (a.i === b.i && (a.c || 0) < (b.c || 0));

  function pick() {
    const active = document.activeElement;
    if (active && container.contains(active)) {
      const p = positionOf(active);
      if (p) {
        current = p;
        return active;
      }
    }
    const held = current && nodeAt(current);
    if (held && inView(held)) return held;
    let best = null;
    let bestPos = null;
    for (const n of container.querySelectorAll(selector)) {
      const p = positionOf(n);
      if (!p || !inView(n)) continue;
      if (!bestPos || before(p, bestPos)) {
        best = n;
        bestPos = p;
      }
    }
    return best;
  }

  function syncNow() {
    const chosen = pick();
    for (const n of container.querySelectorAll(selector)) n.tabIndex = n === chosen ? 0 : -1;
  }
  // Renders come every scroll frame: re-pick once they settle, not on each.
  let timer = null;
  function sync() {
    clearTimeout(timer);
    timer = setTimeout(syncNow, 120);
  }

  container.addEventListener('focusin', (e) => {
    const p = positionOf(e.target);
    if (!p) return;
    current = p;
    syncNow();
  });
  container.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const p = positionOf(e.target);
    if (!p) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.target.click();
      return;
    }
    const to = move(p, e.key);
    if (!to) return;
    e.preventDefault();
    const n = nodeAt(to);
    if (n) n.focus(); // focusing scrolls it into view; the list renders around it
  });

  return { sync, syncNow };
}
