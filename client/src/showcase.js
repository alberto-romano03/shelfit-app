// First-launch app showcase — a near-full-screen paged sheet that introduces the
// app's main features. Auto-shown once on first launch (see Home.js), and
// re-openable any time from the header "?" button. It is NOT a step-by-step
// tutorial: each page pairs a short title + one line with a minimal illustration.
//
// The visuals are pure CSS + inline SVG (see the .showcase / .sc-* rules in
// styles.css) — decorative multi-part artwork (discs, a ticket, a receipt, the
// Kodi logo) which is exactly the case the masked-file icon path can't serve, so
// it is inlined here per the icon rule in ui.js. No images, no libraries.
//
// The sheet reuses the app's modal chrome: the shared .modal-backdrop, the
// slideUp/slideDown + backdrop fade animations, and lockScroll/unlockScroll — so
// it enters, leaves and traps scroll exactly like every other popup.

import { el, lockScroll, unlockScroll } from './ui.js';
import { t } from './i18n.js';

// --- Inline SVGs for the illustrations -------------------------------------
const SPARK =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.7a2 2 0 0 0 1.3 1.3L21 11l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 20l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 11l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>';
const DISC3 =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2"/></svg>';
const CAL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';
const CIRCLE_PLAY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>';
const DISC_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/></svg>';
// Matches the real "Seen in cinema" toggle icon in Detail.js.
const CINEMA_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>';
const CHEVRON_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
// Kodi logo (public/icons/kodi.svg) — four blue diamonds; inlined so it keeps its
// brand colour inside the illustration.
const KODI_LOGO =
  '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g fill="#17b2e7"><path d="M512 260.2c-1.6 5.4-5.3 9.3-9.1 13.1-26 25.9-51.9 51.8-77.8 77.8-9.3 9.4-19.3 9.3-28.7-.1-26.7-26.8-53.5-53.5-80.2-80.3-9.1-9.1-9.1-19.1 0-28.2 26.9-26.9 53.8-53.8 80.7-80.8 8.8-8.8 19-8.8 27.8 0 26.1 26.1 52.1 52.2 78.2 78.2 3.9 3.9 7.5 7.8 9.1 13.2z"/><path d="M254.2 511c-5.3-1.7-9.2-5.4-13-9.3-25.9-26-51.8-51.9-77.7-77.8-9.3-9.3-9.3-19.2 0-28.5 26.8-26.8 53.6-53.7 80.5-80.5 8.9-8.9 19.1-9 28-.1 26.8 26.8 53.6 53.7 80.5 80.5 9.2 9.2 9.2 19.3.1 28.5-26.1 26.2-52.3 52.3-78.4 78.5-3.7 3.7-7.6 7.1-12.8 8.6-2.5.1-4.9.1-7.2.1"/><path d="M160.1 192.4c0-29.8.3-59.7-.2-89.5-.1-8.6 1.9-15.4 8.5-21.1 5.3-4.6 10-9.9 15-14.9 19.7-19.7 39.3-39.4 59-59 9.3-9.3 19.2-9.2 28.5 0 26.8 26.8 53.5 53.5 80.2 80.3 9.2 9.2 9.2 19.3 0 28.5-31.6 31.7-63.3 63.3-94.9 95-27.9 28-55.9 55.9-83.8 83.9-5.2 5.2-9.8 4-11.6-3.2-.6-2.2-.6-4.6-.6-6.9-.1-31.1-.1-62.1-.1-93.1"/><path d="M96.1 257.1c0 27.4 0 54.8-.1 82.2 0 2.6-.4 5.4-1.4 7.8-1.8 4.8-5.3 5.3-8.8 1.8-12.6-12.6-25.2-25.2-37.7-37.8C33.6 296.5 19 282 4.5 267.4c-6-6-6-14.4 0-20.4 26.7-27.1 53.5-54.1 80.3-81.1 1.8-1.8 3.4-4.2 6.4-3.1 2.9 1.1 4 3.7 4.4 6.6.3 1.8.5 3.6.5 5.4z"/></g></svg>';
// The monthly receipt drawn as one SVG: paper silhouette with rounded torn zigzag
// top/bottom (fill+stroke, round joins → rounded triangle tips, half-triangles at
// the corners) + three placeholder "text" bars.
const RECEIPT =
  '<svg viewBox="0 0 100 152" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M6 6 L17 15 L28 6 L39 15 L50 6 L61 15 L72 6 L83 15 L94 6 L94 146 L83 137 L72 146 L61 137 L50 146 L39 137 L28 146 L17 137 L6 146 Z" fill="#f6f2ea" stroke="#f6f2ea" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>' +
  '<rect x="19" y="50" width="50" height="7" rx="3.5" fill="#4a4a4a"/>' +
  '<rect x="19" y="73" width="62" height="7" rx="3.5" fill="#4a4a4a"/>' +
  '<rect x="19" y="96" width="38" height="7" rx="3.5" fill="#4a4a4a"/>' +
  '</svg>';

const NAV = {
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

// Escape a value that will be interpolated into an illustration's HTML string.
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The page list, rebuilt at open time so every label reads from t() in the
// current language. Sample proper nouns (show/film titles, the season/episode
// code) stay verbatim, like every other user/library string in the app.
function buildPages() {
  const cat = (cls, key) => `<span class="sc-cchip ${cls}">${esc(t(key))}</span>`;
  return [
    {
      title: 'showcase.p1.title',
      desc: 'showcase.p1.desc',
      viz: `<div class="sc-viz"><div class="sc-cd"><div class="sc-disc"></div><div class="sc-ring"></div><div class="sc-hole"></div></div></div>`,
    },
    {
      title: 'showcase.p2.title',
      desc: 'showcase.p2.desc',
      viz: `<div class="sc-viz"><div class="sc-wall">
        <div class="sc-grid"><span class="sc-poster"></span><span class="sc-poster"></span><span class="sc-poster"></span><span class="sc-poster"></span><span class="sc-poster"></span><span class="sc-poster"></span></div>
        ${cat('c1', 'showcase.cat.scifi')}${cat('c2', 'showcase.cat.drama')}${cat('c3', 'showcase.cat.comedy')}${cat('c4', 'showcase.cat.thriller')}
      </div></div>`,
    },
    {
      title: 'showcase.p3.title',
      desc: 'showcase.p3.desc',
      viz: `<div class="sc-viz"><div class="sc-detail">
        <div class="sc-dt-head"><span class="sc-dt-poster"></span><div><div class="sc-dt-title">Blade Runner 2049</div><div class="sc-dt-sub">2017 · Sci-Fi</div></div></div>
        <div class="sc-status"><span class="sc-ic">${CIRCLE_PLAY}</span><span class="sc-cur">${esc(t('showcase.demo.watching'))}</span><span class="sc-caret">${CHEVRON_DOWN}</span></div>
        <div class="sc-chips"><span class="sc-chip">${DISC_ICON}<span>${esc(t('showcase.demo.owned'))}</span></span><span class="sc-chip sc-on">${CINEMA_ICON}<span>${esc(t('detail.seenInCinema'))}</span></span></div>
      </div></div>`,
    },
    {
      title: 'showcase.p4.title',
      desc: 'showcase.p4.desc',
      viz: `<div class="sc-viz"><div class="sc-ticket">
        <div class="sc-tk-top"><div class="sc-tk-banner"></div><div class="sc-tk-body"><div class="sc-tk-title">Dune: Part Two</div></div></div>
        <div class="sc-tk-tear"></div>
        <div class="sc-tk-stub"><div class="sc-tk-barcode"></div></div>
      </div></div>`,
    },
    {
      title: 'showcase.p5.title',
      desc: 'showcase.p5.desc',
      viz: `<div class="sc-viz"><div class="sc-shelf">
        <div class="sc-spines">
          <span class="sc-spine sc-s1"><span class="sc-band">${DISC3}</span></span>
          <span class="sc-spine sc-s2 sc-lift"><span class="sc-band">${DISC3}</span></span>
          <span class="sc-spine sc-s3"><span class="sc-band">${DISC3}</span></span>
          <span class="sc-disc-out"></span>
        </div>
        <div class="sc-ledge"></div>
      </div></div>`,
    },
    {
      title: 'showcase.p6.title',
      desc: 'showcase.p6.desc',
      viz: `<div class="sc-viz"><div class="sc-dust">
        <div class="sc-dust-stage">
          <div class="sc-dust-card"></div>
          <div class="sc-spark sc-a">${SPARK}</div><div class="sc-spark sc-b">${SPARK}</div><div class="sc-spark sc-c">${SPARK}</div>
        </div>
        <div class="sc-moods"><span class="sc-mood sc-on">${esc(t('showcase.demo.mood.tense'))}</span><span class="sc-mood">${esc(t('showcase.demo.mood.short'))}</span><span class="sc-mood">${esc(t('showcase.demo.mood.era'))}</span></div>
      </div></div>`,
    },
    {
      title: 'showcase.p7.title',
      desc: 'showcase.p7.desc',
      viz: `<div class="sc-viz"><div class="sc-next">
        <div class="sc-tl sc-watch"><div class="sc-tl-t">Severance</div><span class="sc-tl-chip sc-ep">S2 · E4</span></div>
        <div class="sc-tl sc-soon"><div class="sc-tl-t">The Bear</div><span class="sc-tl-chip sc-cal">${CAL}<span>${esc(t('showcase.demo.newEp'))}</span></span></div>
      </div></div>`,
    },
    {
      title: 'showcase.p8.title',
      desc: 'showcase.p8.desc',
      viz: `<div class="sc-viz"><div class="sc-receipt">${RECEIPT}</div></div>`,
    },
    {
      title: 'showcase.p9.title',
      desc: 'showcase.p9.desc',
      viz: `<div class="sc-viz"><div class="sc-kodi">
        <div class="sc-tv"><div class="sc-kodi-logo">${KODI_LOGO}</div></div>
        <div class="sc-kodi-chip">${CIRCLE_PLAY}<span>${esc(t('detail.playOnKodi'))}</span></div>
      </div></div>`,
    },
  ];
}

let openInstance = null; // guard against a second sheet stacking on the first

export function openShowcase() {
  if (openInstance) return openInstance;
  const PAGES = buildPages();
  let index = 0;

  const backdrop = el('div', { class: 'modal-backdrop' });
  const sheet = el('div', { class: 'showcase', role: 'dialog', 'aria-modal': 'true' });

  const skip = el('button', { class: 'sc-skip', type: 'button', text: t('showcase.skip') });
  const header = el('div', { class: 'sc-header' }, [el('div', { class: 'sc-handle' }), skip]);

  const track = el('div', { class: 'sc-track' });
  PAGES.forEach((p) => {
    track.append(
      el('div', { class: 'sc-page' }, [
        el('div', { class: 'sc-viz-wrap', html: p.viz }),
        el('h2', { class: 'sc-title', text: t(p.title) }),
        el('p', { class: 'sc-desc', text: t(p.desc) }),
      ])
    );
  });
  const viewport = el('div', { class: 'sc-viewport' }, [track]);

  const dots = el('div', { class: 'sc-dots' }, PAGES.map(() => el('span', { class: 'sc-dot' })));
  const prevBtn = el('button', { class: 'btn btn-secondary', type: 'button', html: `${NAV.left}<span>${esc(t('showcase.back'))}</span>` });
  const nextBtn = el('button', { class: 'btn btn-primary', type: 'button' });
  const footer = el('div', { class: 'sc-footer' }, [dots, el('div', { class: 'sc-nav' }, [prevBtn, nextBtn])]);

  sheet.append(header, viewport, footer);
  backdrop.append(sheet);

  const pages = [...track.children];
  const dotEls = [...dots.children];
  const isLast = () => index === PAGES.length - 1;

  function update() {
    track.style.transform = `translateX(${-index * 100}%)`;
    pages.forEach((pg, i) => pg.classList.toggle('is-active', i === index));
    dotEls.forEach((d, i) => d.classList.toggle('is-active', i === index));
    prevBtn.disabled = index === 0;
    nextBtn.innerHTML = isLast()
      ? `${NAV.check}<span>${esc(t('showcase.start'))}</span>`
      : `<span>${esc(t('showcase.next'))}</span>${NAV.right}`;
  }
  function go(i) {
    index = Math.max(0, Math.min(PAGES.length - 1, i));
    update();
  }

  prevBtn.addEventListener('click', () => go(index - 1));
  nextBtn.addEventListener('click', () => (isLast() ? close() : go(index + 1)));
  skip.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  // Horizontal swipe between pages (pointer-based). A gesture that reads as
  // vertical is left alone so the page can still scroll if it ever overflows.
  let startX = 0, startY = 0, dragging = false, decided = false, horizontal = false;
  viewport.addEventListener('pointerdown', (e) => {
    startX = e.clientX; startY = e.clientY; dragging = true; decided = false; horizontal = false;
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      decided = true;
      horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (decided && horizontal) {
      track.style.transition = 'none';
      track.style.transform = `translateX(${-index * viewport.clientWidth + dx}px)`;
    }
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    track.style.transition = '';
    if (decided && horizontal) {
      const dx = e.clientX - startX;
      if (dx < -50) go(index + 1);
      else if (dx > 50) go(index - 1);
      else update();
    }
  }
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  function onKey(e) {
    if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'ArrowLeft') go(index - 1);
    else if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  let closed = false, removed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    sheet.classList.add('sheet-closing');
    backdrop.classList.add('backdrop-closing');
    const done = () => {
      if (removed) return;
      removed = true;
      backdrop.remove();
      unlockScroll();
      openInstance = null;
    };
    sheet.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400); // fallback if animationend never fires
  }

  lockScroll();
  document.body.append(backdrop);
  update();
  openInstance = { close };
  return openInstance;
}

export default openShowcase;
