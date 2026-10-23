// "My Tickets" — the cinema ticket collection modal (opened from The Desk drawer
// on the home screen). A tall bottom sheet with two views on one segmented
// control: "Ticket" shows one ticket at a time, with swipe (mobile) / arrow
// (desktop) navigation and a position indicator; "Collection" shows every ticket
// at once as a miniature, grouped by the chosen sort, and a tap opens that one.
// Tickets themselves are built solely by renderTicket() / renderMiniTicket() in
// cinemaTicket.js.
// Also the "New ticket" popup shown when a movie is marked as seen in cinema.

import {
  openSheet,
  openModal,
  el,
  icons,
  toast,
  spinner,
  lucideIcon,
  segmentedControl,
  selectPill,
} from './ui.js';
import { withBase } from './basePath.js';
import { api } from './api.js';
import { attachSwipe } from './swipe.js';
import { imageCache } from './imageCache.js';
import { renderTicket, renderMiniTicket, ticketFromApi, formatTicketDate } from './cinemaTicket.js';
import { t, locale } from './i18n.js';

// --- Sorting ----------------------------------------------------------------
// The date a ticket SHOWS: the screening date, else the release date it falls
// back to. Sorting by it keeps the order in step with what each ticket reads
// (most tickets carry no screening date, so the server's order looked random).
const shownDate = (tk) => tk.cinemaDate || tk.releaseDate || '';
const titleCollator = () => new Intl.Collator(locale(), { sensitivity: 'base', numeric: true });

// Each sort: how to order the tickets, and the group a ticket falls in (the
// collection's section dividers: year, initial, or cinema).
const TICKET_SORTS = {
  newest: {
    cmp: (a, b) =>
      shownDate(b).localeCompare(shownDate(a)) || (b.cinemaTime || '').localeCompare(a.cinemaTime || ''),
    group: (tk) => shownDate(tk).slice(0, 4) || '—',
  },
  oldest: {
    cmp: (a, b) =>
      shownDate(a).localeCompare(shownDate(b)) || (a.cinemaTime || '').localeCompare(b.cinemaTime || ''),
    group: (tk) => shownDate(tk).slice(0, 4) || '—',
  },
  title: {
    cmp: (a, b) => titleCollator().compare(a.title || '', b.title || ''),
    group: (tk) => {
      const c = (tk.title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
      return /[A-Z]/.test(c) ? c : '#';
    },
  },
  // By cinema, tickets without one last; newest first within each cinema.
  cinema: {
    cmp: (a, b) =>
      !a.cinemaName - !b.cinemaName ||
      titleCollator().compare(a.cinemaName || '', b.cinemaName || '') ||
      shownDate(b).localeCompare(shownDate(a)),
    group: (tk) => tk.cinemaName || t('ticket.noCinema'),
  },
};

// The chosen sort is a per-device convenience, remembered like a filter.
const SORT_KEY = 'shelfit:ticketSort';
function readTicketSort() {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return TICKET_SORTS[v] ? v : 'newest';
  } catch {
    return 'newest';
  }
}
function writeTicketSort(v) {
  try {
    localStorage.setItem(SORT_KEY, v);
  } catch {
    /* private mode / storage off: the sort just isn't remembered */
  }
}

const reduceMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Local calendar date as 'YYYY-MM-DD' (no UTC shift): a new ticket is "today".
function localTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The screening time a new ticket starts on.
const NEW_TICKET_TIME = '20:30';

// "New ticket" popup, opened when a movie is marked as seen in cinema. Shows the
// ticket exactly as it will appear in My Tickets, floating, and edited in place
// through the ticket's own date / time / cinema fields. A chip fills in the
// release date for screenings whose real date is forgotten. Nothing is saved
// until Add: `onConfirm({ cinema_date, cinema_time, cinema_name })` (async,
// throws on failure, which keeps the popup open). Cancel adds nothing.
//   movie: { id, tmdbId, title, backdropPath, releaseDate }
export function openNewTicketModal({ movie, onConfirm }) {
  return openModal((modal, close) => {
    const draft = {
      id: movie.id,
      tmdbId: movie.tmdbId,
      title: movie.title,
      backdropPath: movie.backdropPath,
      cinemaDate: localTodayISO(),
      cinemaTime: NEW_TICKET_TIME,
      cinemaName: null,
      releaseDate: movie.releaseDate || null,
    };
    let cinemas = [];

    // Floating like in My Tickets (the host carries the bob animation).
    const host = el('div', { class: 'cine-ticket-host' });
    let syncChip = () => {};
    function mountTicket() {
      host.replaceChildren(
        renderTicket(draft, {
          cinemas,
          onDateChange: (v) => {
            draft.cinemaDate = v;
            syncChip();
          },
          onTimeChange: (v) => {
            draft.cinemaTime = v;
          },
          onCinemaChange: (v) => {
            draft.cinemaName = v;
          },
        })
      );
    }
    mountTicket();
    // The popup opens at once; the cinema options arrive after and the ticket is
    // rebuilt from the draft, so nothing picked so far is lost. Without a list
    // the cinema field stays free text, as on any ticket.
    api
      .cinemaList()
      .then((res) => {
        const list = (res && res.cinemas) || [];
        if (!list.length || !host.isConnected) return;
        cinemas = list;
        mountTicket();
      })
      .catch(() => {});

    // Release-date shortcut: writes into the ticket's own date field and fires
    // its change, the same path as a manual pick, so the ticket re-renders it.
    // Lit while the ticket shows the release date; absent when there is none.
    let shortcut = null;
    if (draft.releaseDate) {
      const chip = el('button', { class: 'chip', type: 'button' }, [
        lucideIcon('clapperboard', 'btn-lucide'),
        el('span', { text: `${t('ticket.useRelease')} · ${formatTicketDate(draft.releaseDate)}` }),
      ]);
      syncChip = () => chip.classList.toggle('active', draft.cinemaDate === draft.releaseDate);
      chip.addEventListener('click', () => {
        const input = host.querySelector('.cine-field-date .cine-input');
        if (!input) return;
        input.value = draft.releaseDate;
        input.dispatchEvent(new Event('change'));
      });
      syncChip();
      shortcut = el('div', { class: 'cine-new-shortcut' }, [chip]);
    }

    const addBtn = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('ticket', 'btn-lucide'),
      el('span', { text: t('ticket.add') }),
    ]);
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      try {
        await onConfirm({
          cinema_date: draft.cinemaDate,
          cinema_time: draft.cinemaTime,
          cinema_name: draft.cinemaName,
        });
        close();
      } catch (err) {
        addBtn.disabled = false;
        toast((err && err.message) || t('ticket.couldNotSave'), 'bad');
      }
    });

    modal.append(
      el('h3', { text: t('ticket.newTitle') }),
      host,
      shortcut,
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
          lucideIcon('x', 'btn-lucide'),
          el('span', { text: t('common.cancel') }),
        ]),
        addBtn,
      ])
    );
  });
}

const NEXT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

export function openCinemaTickets() {
  openSheet((sheet, close) => {
    let all = []; // every ticket as loaded
    let tickets = []; // `all` in the current sort order (what both views walk)
    let index = 0;
    let sortKey = readTicketSort();

    // Ticket / Collection switch. Hidden until there are tickets to show.
    const viewSeg = segmentedControl({
      options: [
        ['one', t('ticket.viewOne'), 'ticket'],
        ['all', t('ticket.viewAll'), 'wallet-cards'],
      ],
      value: 'one',
      center: true,
      ariaLabel: t('ticket.myTickets'),
      onChange: (v) => (v === 'all' ? showAlbum() : showOne()),
    });
    viewSeg.el.style.display = 'none';
    const head = el('div', { class: 'cine-sheet-head' }, [
      el('div', { class: 'cine-sheet-title', text: t('ticket.myTickets') }),
      viewSeg.el,
    ]);
    const body = el('div', { class: 'cine-sheet-body' });
    // Position indicator ("1 / 27") anchored just above the footer separator, so it
    // stays put regardless of the current ticket's height.
    const progress = el('div', { class: 'cine-progress' });
    // Bottom close action with a separator above it — matches every other modal.
    const footer = el('div', { class: 'cine-sheet-footer' }, [
      progress,
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.close') }),
    ]),
      ]),
    ]);
    sheet.append(head, body, footer);

    // Mobile scroll containment. The shared body-scroll lock (ui.js) freezes the
    // page but intentionally lets native touch-scroll happen inside any `.modal`
    // so scrollable sheets still work — Dust It Off relies on its `.sheet-body`
    // consuming that scroll. This sheet's content usually FITS (one ticket), so a
    // vertical drag has nothing to scroll and would bleed through to the page.
    // Mirror the lock's own tactic here: block the touchmove whenever the body
    // has nothing to scroll (and always leave pinch-zoom and a genuinely
    // scrollable body — tiny screens — alone). Horizontal ticket swipes use
    // pointer events + touch-action:pan-y, so they're unaffected.
    sheet.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches && e.touches.length > 1) return; // pinch-zoom
        const scroller = e.target.closest && e.target.closest('.cine-sheet-body');
        const canScroll = scroller && scroller.scrollHeight > scroller.clientHeight + 1;
        if (!canScroll) e.preventDefault();
      },
      { passive: false }
    );

    // Persistent carousel chrome — created once; only the hosted ticket changes.
    const host = el('div', { class: 'cine-ticket-host' });
    const prevBtn = el('button', {
      class: 'cine-arrow cine-prev',
      html: icons.back,
      'aria-label': t('ticket.previous'),
      onClick: () => slide(-1),
    });
    const nextBtn = el('button', {
      class: 'cine-arrow cine-next',
      html: NEXT_ICON,
      'aria-label': t('ticket.next'),
      onClick: () => slide(1),
    });
    const stage = el('div', { class: 'cine-stage' }, [prevBtn, host, nextBtn]);
    let cinemas = []; // cinema-name options (from GET /api/cinema/list)

    // Eased transitions (set inline so they never fight the drag's transition:none).
    // Spring-ish back for a released-but-not-committed drag; ease-in for the
    // outgoing ticket, gentle ease-out for the incoming one.
    const T_BACK = 'transform 0.4s cubic-bezier(0.34, 1.4, 0.5, 1), opacity 0.3s ease';
    const T_OUT = 'transform 0.24s cubic-bezier(0.4, 0, 1, 1), opacity 0.24s ease';
    const T_IN = 'transform 0.38s cubic-bezier(0.16, 0.9, 0.4, 1), opacity 0.32s ease';
    // A miniature growing into the full ticket (ease-out: settling into place).
    const T_FLY = 'transform 0.42s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.3s ease';
    let animating = false;

    const atEdge = (delta) => index + delta < 0 || index + delta >= tickets.length;

    function buildTicket() {
      const t = tickets[index];
      const node = renderTicket(t, {
        cinemas,
        onDateChange: (v) => saveCinema(t, { cinema_date: v }, 'cinemaDate', v),
        onTimeChange: (v) => saveCinema(t, { cinema_time: v }, 'cinemaTime', v),
        onCinemaChange: (v) => saveCinema(t, { cinema_name: v }, 'cinemaName', v),
      });
      // Swipe follows the finger 1:1 (with soft resistance past the ends); a
      // release past the threshold slides to the neighbour, otherwise it springs
      // back. Right → previous, left → next, matching the other carousels.
      attachSwipe(node, {
        isBlocked: () => animating || tickets.length < 2,
        onStart: () => {
          node.style.transition = 'none';
        },
        onMove: (dx) => {
          // Rubber-band when there's nothing to reveal that way (dx>0 → prev).
          const resist = (dx > 0 ? atEdge(-1) : atEdge(1)) ? 0.32 : 1;
          const eff = dx * resist;
          const rot = Math.max(-7, Math.min(7, eff * 0.02));
          node.style.transform = `translateX(${eff}px) rotate(${rot}deg)`;
          node.style.opacity = String(Math.max(0.5, 1 - Math.abs(eff) / (window.innerWidth * 0.85)));
        },
        onRest: () => snapBack(node),
        onSwipe: (dir) => {
          const delta = dir === 1 ? -1 : 1; // right → prev, left → next
          if (atEdge(delta)) snapBack(node);
          else slide(delta, node);
        },
      });
      return node;
    }

    function snapBack(node) {
      node.style.transition = T_BACK;
      node.style.transform = '';
      node.style.opacity = '';
    }

    function renderControls() {
      progress.textContent = `${index + 1} / ${tickets.length}`;
      progress.style.display = tickets.length > 1 ? '' : 'none';
      const single = tickets.length < 2;
      prevBtn.disabled = single || index === 0;
      nextBtn.disabled = single || index === tickets.length - 1;
    }

    // Warm the imageCache with the neighbouring tickets' backdrop wallpapers so
    // swiping/clicking to them paints instantly — the image is already decoded
    // rather than loading in as you land. A sliding window of just the immediate
    // prev + next (not the whole collection); fire-and-forget at low background
    // priority so it never delays the current ticket's own image.
    function preloadAdjacent() {
      for (const i of [index + 1, index - 1]) {
        const t = tickets[i];
        if (t && t.backdropPath) imageCache.load(t.backdropPath, { preload: true }).catch(() => {});
      }
    }

    function mount() {
      host.replaceChildren(buildTicket());
      renderControls();
      preloadAdjacent();
    }

    // Animated navigation: the current ticket slides off toward the swipe/arrow
    // direction while the neighbour eases in from the opposite side. `fromNode`
    // (a ticket possibly mid-drag) continues from wherever the finger left it.
    function slide(delta, fromNode) {
      if (animating || atEdge(delta)) return;
      animating = true;
      const outgoing = fromNode || host.firstElementChild;
      const W = (host.offsetWidth || 320) + 48;
      const outDir = delta > 0 ? -1 : 1; // next → exit left, prev → exit right
      if (outgoing) {
        outgoing.style.transition = T_OUT;
        outgoing.style.transform = `translateX(${outDir * W}px) rotate(${outDir * 6}deg)`;
        outgoing.style.opacity = '0';
      }
      window.setTimeout(() => {
        index += delta;
        const incoming = buildTicket();
        incoming.style.transition = 'none';
        incoming.style.transform = `translateX(${-outDir * W}px)`;
        incoming.style.opacity = '0';
        host.replaceChildren(incoming);
        renderControls();
        preloadAdjacent(); // warm the next/prev wallpaper for the following move
        void incoming.offsetWidth; // reflow so the transition below actually runs
        incoming.style.transition = T_IN;
        incoming.style.transform = 'translateX(0)';
        incoming.style.opacity = '1';
        window.setTimeout(() => {
          incoming.style.transition = '';
          animating = false;
        }, 360);
      }, 140);
    }

    // Optimistic save of a date/time edit. renderTicket already updated the field
    // label; on failure we revert the model and re-render.
    async function saveCinema(ticket, patch, key, val) {
      const prev = ticket[key];
      ticket[key] = val;
      albumStale = true; // the miniature's date (and maybe its place) changed
      try {
        await api.updateCinema(ticket.id, patch);
      } catch (err) {
        ticket[key] = prev;
        toast(err.message || t('ticket.couldNotSave'), 'bad');
        mount();
      }
    }

    function showEmpty() {
      const icon = el('span', { class: 'cine-empty-icon' });
      const url = `url("${withBase('/icons/lucide/ticket.svg')}")`;
      icon.style.webkitMaskImage = url;
      icon.style.maskImage = url;
      body.replaceChildren(
        el('div', { class: 'cine-empty' }, [
          icon,
          el('div', {
            class: 'cine-empty-text',
            text: t('ticket.empty'),
          }),
        ])
      );
    }

    function showMessage(msg) {
      body.replaceChildren(el('div', { class: 'cine-empty' }, [el('div', { class: 'cine-empty-text', text: msg })]));
    }

    // --- Sort + collection --------------------------------------------------
    // Re-sort keeping the ticket in view the same one, so changing the order
    // (or an edited date moving a ticket) never jumps to a different ticket.
    function applySort() {
      const current = tickets[index];
      tickets = all.slice().sort(TICKET_SORTS[sortKey].cmp);
      index = Math.max(0, current ? tickets.indexOf(current) : 0);
    }

    // The grid's sort pill, with the ticket orders. Lives in the collection,
    // where the order is visible; the single view walks the same order.
    const sortPill = selectPill({
      label: t('grid.sort'),
      options: [
        { value: 'newest', text: t('ticket.sortNewest') },
        { value: 'oldest', text: t('ticket.sortOldest') },
        { value: 'title', text: t('grid.sortTitle'), short: 'A–Z' },
        { value: 'cinema', text: t('ticket.sortCinema') },
      ],
      value: sortKey,
      onChange: (v) => {
        sortKey = v;
        writeTicketSort(v);
        applySort();
        renderAlbum();
        decodeFirstScreen(); // in view already: just get the new first rows painted
      },
    });
    const album = el('div', { class: 'cine-album' });
    const albumPage = el('div', {}, [el('div', { class: 'filter-bar' }, [sortPill.el]), album]);

    // The album is built once and kept: going back to the collection only moves
    // the "current" mark. It's rebuilt when the order or a ticket's details
    // changed (sort pill, an edit in the single view, a fresh load).
    let albumStale = true;
    let albumMinis = [];
    let albumToken = 0; // drops a stale showAlbum if the view switched back meanwhile
    // Miniatures in the first screenful (3 columns x 4 rows): the only ones that
    // deal in, and the ones decoded before the album is shown.
    const FIRST_SCREEN = 12;

    // Every ticket as a miniature, a .grid-divider opening each group of the
    // current sort. The ticket last in view is marked; a tap opens that ticket.
    function renderAlbum() {
      const groupOf = TICKET_SORTS[sortKey].group;
      const nodes = [];
      let prevGroup = null;
      albumMinis = tickets.map((tk, i) => {
        const g = groupOf(tk);
        if (g !== prevGroup) {
          nodes.push(el('div', { class: 'grid-divider' }, [el('span', { class: 'grid-divider-label', text: g })]));
          prevGroup = g;
        }
        const mini = renderMiniTicket(tk);
        if (i < FIRST_SCREEN) mini.style.setProperty('--deal-i', String(i));
        else mini.classList.add('is-still');
        mini.addEventListener('click', () => openFromAlbum(i, mini));
        nodes.push(mini);
        return mini;
      });
      album.replaceChildren(...nodes);
      markCurrent();
      albumStale = false;
    }

    function markCurrent() {
      albumMinis.forEach((mini, i) => mini.classList.toggle('is-current', i === index));
    }

    // Decode the first screenful's backdrops off-screen, in one batch, so the
    // album appears with its images already painted instead of each one popping
    // in on its own frame. Only images already in imageCache (blob URLs) can
    // decode detached. Capped below the segmented chip's own slide, so a slow
    // device (or a backgrounded tab, where decode() can stall) never holds the
    // view back noticeably.
    function decodeFirstScreen() {
      const imgs = albumMinis
        .slice(0, FIRST_SCREEN)
        .map((mini) => mini.querySelector('.cine-mini-banner img'))
        .filter((img) => img && img.decode && String(img.src).startsWith('blob:'));
      if (!imgs.length) return Promise.resolve();
      const decoded = Promise.all(imgs.map((img) => img.decode().catch(() => {})));
      return Promise.race([decoded, new Promise((r) => window.setTimeout(r, 120))]);
    }

    async function showAlbum() {
      const token = ++albumToken;
      const rebuilt = albumStale;
      if (albumStale) {
        applySort(); // pick up any date edited in the single view
        renderAlbum();
      } else {
        markCurrent();
      }
      // A kept album's images were decoded the first time it showed: no wait.
      if (rebuilt) await decodeFirstScreen();
      if (token !== albumToken || viewSeg.value() !== 'all') return; // switched back meanwhile
      body.classList.add('is-album');
      // No position in the collection; the album runs down to the footer rule.
      footer.classList.add('is-album');
      progress.style.display = 'none';
      body.replaceChildren(albumPage);
      body.scrollTop = 0; // always open at the top: the sort and the first group
    }

    function showOne() {
      albumToken++; // cancels a showAlbum still decoding
      body.classList.remove('is-album');
      footer.classList.remove('is-album');
      progress.style.display = '';
      body.scrollTop = 0;
      body.replaceChildren(stage);
      mount();
    }

    // Tap a miniature: back to the single view on that ticket, which grows out
    // of the miniature's place in the album.
    function openFromAlbum(i, mini) {
      const from = mini.getBoundingClientRect();
      index = i;
      viewSeg.set('one');
      showOne();
      const ticket = host.firstElementChild;
      if (!ticket || reduceMotion()) return;
      const to = ticket.getBoundingClientRect();
      if (!to.width) return;
      const s = from.width / to.width;
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + (to.height * s) / 2 - (to.top + to.height / 2);
      ticket.style.transition = 'none';
      ticket.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
      ticket.style.opacity = '0.4';
      void ticket.offsetWidth; // reflow so the transition below actually runs
      ticket.style.transition = T_FLY;
      ticket.style.transform = '';
      ticket.style.opacity = '';
      window.setTimeout(() => {
        ticket.style.transition = '';
      }, 450);
    }

    // Shared app loader: the rotating disc + a random loading phrase.
    body.replaceChildren(spinner({ compact: true }));
    // Load tickets + the cinema-name options together. A failed list fetch just
    // means the ticket's cinema field falls back to free text.
    Promise.all([api.cinemaTickets(), api.cinemaList().catch(() => ({ cinemas: [] }))])
      .then(([res, listRes]) => {
        cinemas = (listRes && listRes.cinemas) || [];
        all = (res.tickets || []).map(ticketFromApi);
        if (!all.length) {
          showEmpty();
          return;
        }
        applySort();
        index = 0;
        viewSeg.el.style.display = '';
        showOne();
        // Warm every backdrop in display order at background priority (the same
        // scheduler as the grid preloader, so it never delays a visible image).
        // The collection then paints from RAM, and swiping in the single view
        // lands on images that are already there.
        imageCache.preload(tickets.map((tk) => tk.backdropPath).filter(Boolean));
      })
      .catch(() => showMessage(t('ticket.loadError')));
  });
}
