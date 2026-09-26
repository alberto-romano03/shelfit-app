// "My Tickets" — the cinema ticket collection modal (opened from The Desk drawer
// on the home screen). A tall bottom sheet showing one ticket at a time, with
// swipe (mobile) / arrow (desktop) navigation and a position indicator. Tickets
// themselves are built solely by renderTicket() in cinemaTicket.js.

import { openSheet, el, icons, toast, spinner, lucideIcon } from './ui.js';
import { withBase } from './basePath.js';
import { api } from './api.js';
import { attachSwipe } from './swipe.js';
import { imageCache } from './imageCache.js';
import { renderTicket, ticketFromApi } from './cinemaTicket.js';
import { t } from './i18n.js';

const NEXT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

export function openCinemaTickets() {
  openSheet((sheet, close) => {
    let tickets = [];
    let index = 0;

    const head = el('div', { class: 'cine-sheet-head' }, [
      el('div', { class: 'cine-sheet-title', text: t('ticket.myTickets') }),
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

    // Shared app loader: the rotating disc + a random loading phrase.
    body.replaceChildren(spinner({ compact: true }));
    // Load tickets + the cinema-name options together. A failed list fetch just
    // means the ticket's cinema field falls back to free text.
    Promise.all([api.cinemaTickets(), api.cinemaList().catch(() => ({ cinemas: [] }))])
      .then(([res, listRes]) => {
        cinemas = (listRes && listRes.cinemas) || [];
        tickets = (res.tickets || []).map(ticketFromApi);
        if (!tickets.length) {
          showEmpty();
          return;
        }
        body.replaceChildren(stage);
        mount();
      })
      .catch(() => showMessage(t('ticket.loadError')));
  });
}
