// Cinema ticket — the single source of truth for a ticket's data shape and its
// DOM. No ticket markup is defined anywhere else; every ticket in the app is
// produced by renderTicket(), and its stub-sized collection form by
// renderMiniTicket(). Pure CSS + vanilla DOM (see .cine-ticket / .cine-mini in
// styles.css) — no canvas, no barcode library.

import { el, cachedImg, lucideIcon, mountPoster } from './ui.js';
import { withBase } from './basePath.js';
import { t, locale } from './i18n.js';

// Ticket data model:
//   { tmdbId, title, backdropPath, cinemaDate, cinemaTime, cinemaName, releaseDate }
// backdropPath is a local cached backdrop URL (/assets/movies/<id>/backdrop.webp),
// never a direct TMDB URL. cinemaDate / cinemaTime are null until the user sets
// them (ISO 'YYYY-MM-DD' and 'HH:MM'); cinemaName is the chosen cinema (null until
// set); releaseDate is the movie's release date, used as the default shown when no
// cinema date is stored.
export function ticketFromApi(row) {
  return {
    id: row.id,
    tmdbId: row.tmdb_id,
    title: row.title,
    backdropPath: row.backdrop_url,
    cinemaDate: row.cinema_date || null,
    cinemaTime: row.cinema_time || null,
    cinemaName: row.cinema_name || null,
    releaseDate: row.release_date || null,
  };
}

// Default time when none is stored — a typical evening screening.
const DEFAULT_TIME = '21:00';

// Format an ISO 'YYYY-MM-DD' as a readable local date ("5 Aug 2026"). Parsed
// component-wise so a plain date never shifts a day across time zones. Exported
// so labels beside a ticket (the new-ticket popup) read exactly like the ticket.
export function formatTicketDate(iso) {
  return formatDate(iso);
}
function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

// Format an 'HH:MM' according to the viewer's locale (24h → "21:00", 12h → "9:00 PM").
function formatTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return hhmm || '';
  try {
    return new Date(2000, 0, 1, Number(m[1]), Number(m[2])).toLocaleTimeString(locale(), {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return hhmm;
  }
}

// A native date/time picker styled as a ticket field: an invisible native input
// fills the cell (so a tap opens the OS picker and it stays directly editable),
// preceded by a calendar/clock icon and a label showing the formatted value.
// `fallback` prefills the field when nothing is stored (release date / 21:00) so
// it is never blank; editing still saves the real chosen value.
function pickerField(kind, value, fallback, placeholder, formatFn, iconName, onChange) {
  const input = el('input', { class: 'cine-input', type: kind });
  const initial = value || fallback || '';
  if (initial) input.value = initial;
  const label = el('span', { class: 'cine-input-label' });
  const cell = el('label', { class: `cine-field cine-field-${kind}` }, [
    input,
    lucideIcon(iconName, 'cine-field-icon'),
    label,
  ]);
  const render = () => {
    const v = input.value;
    label.textContent = v ? formatFn(v) : placeholder;
    cell.classList.toggle('is-empty', !v);
  };
  render();
  input.addEventListener('change', () => {
    render();
    if (onChange) onChange(input.value || null);
  });
  return cell;
}

// Cinema-name field, following the same in-place edit pattern as the date/time
// pickers. With a configured cinema list it's a native <select> overlaying the
// cell (tap → OS dropdown), the chosen name shown in the label. With no list it
// falls back to a free-text input. `cinemas` comes from GET /api/cinema/list
// (see data/cinemas.txt); `onChange(value|null)` fires on edit.
function cinemaField(value, cinemas, onChange) {
  const hasList = Array.isArray(cinemas) && cinemas.length > 0;

  if (hasList) {
    const select = el('select', { class: 'cine-input' });
    select.append(el('option', { value: '', text: '' })); // empty → placeholder label
    const names = cinemas.slice();
    if (value && !names.includes(value)) names.unshift(value); // preserve a custom saved value
    for (const name of names) select.append(el('option', { value: name, text: name }));
    select.value = value || '';
    const label = el('span', { class: 'cine-input-label' });
    const cell = el('label', { class: 'cine-field cine-field-cinema' }, [
      select,
      lucideIcon('popcorn', 'cine-field-icon'),
      label,
    ]);
    const render = () => {
      const v = select.value;
      label.textContent = v || t('ticket.cinema');
      cell.classList.toggle('is-empty', !v);
    };
    render();
    select.addEventListener('change', () => {
      render();
      if (onChange) onChange(select.value || null);
    });
    return cell;
  }

  // Free-text fallback (no cinema list configured): a visible input in the field.
  const input = el('input', {
    class: 'cine-input-text',
    type: 'text',
    placeholder: t('ticket.cinema'),
    maxlength: '80',
  });
  if (value) input.value = value;
  const cell = el('label', { class: 'cine-field cine-field-cinema cine-field-text' }, [
    lucideIcon('popcorn', 'cine-field-icon'),
    input,
  ]);
  input.addEventListener('change', () => {
    if (onChange) onChange(input.value.trim() || null);
  });
  return cell;
}

// Decorative seat, stable per movie so a ticket always shows the same seat.
function seatLabel(tmdbId) {
  const n = Math.abs(parseInt(tmdbId, 10) || 0);
  const row = String.fromCharCode(65 + (n % 8)); // A–H
  const seat = String((n % 30) + 1).padStart(2, '0');
  return t('ticket.rowSeat', { row, seat });
}

// A decorative star (kept inline so the ticket needs no icon asset).
const STAR =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.9 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>';

// Build a fully styled cinema ticket element from ticketData. Optional callbacks
// fire when the date/time are edited in place (used by the ticket modal to save
// via PATCH); when omitted the fields are still shown but changes go nowhere.
export function renderTicket(ticketData, { onDateChange, onTimeChange, onCinemaChange, cinemas } = {}) {
  const data = ticketData || {};

  // --- Top section (above the tear line) ---
  const banner = el('div', { class: 'cine-banner' }, [
    cachedImg(data.backdropPath, { class: 'cine-banner-img', alt: '' }),
  ]);

  const title = el('div', { class: 'cine-title', text: data.title || t('ticket.untitled') });

  const adminRow = el('div', { class: 'cine-adminrow' }, [
    el('span', { class: 'cine-admit', text: t('ticket.admitOne') }),
    el('span', { class: 'cine-seat', text: seatLabel(data.tmdbId) }),
  ]);

  const dateField = pickerField('date', data.cinemaDate, data.releaseDate, t('ticket.date'), formatDate, 'calendar', onDateChange);
  const timeField = pickerField('time', data.cinemaTime, DEFAULT_TIME, t('ticket.time'), formatTime, 'clock', onTimeChange);
  const dateTimeRow = el('div', { class: 'cine-datetime' }, [dateField, timeField]);

  const cinemaRow = el('div', { class: 'cine-cinemarow' }, [
    cinemaField(data.cinemaName, cinemas, onCinemaChange),
  ]);

  // Brand row (CINEMA + star) — temporarily commented out to preview how the
  // ticket looks without it. Uncomment (and add `brandRow` back to cine-body
  // below) to restore it.
  // const brandRow = el('div', { class: 'cine-brandrow' }, [
  //   el('span', { class: 'cine-cinema', text: 'CINEMA' }),
  //   el('span', { class: 'cine-star', html: STAR }),
  // ]);

  const top = el('div', { class: 'cine-top' }, [
    banner,
    el('div', { class: 'cine-body' }, [title, adminRow, dateTimeRow, cinemaRow]),
  ]);

  // --- Tear line (dashed rule; the edge notches are masked out in CSS) ---
  const tear = el('div', { class: 'cine-tear' });

  // --- Bottom stub (CSS-only barcode + decorative code) ---
  const stub = el('div', { class: 'cine-stub' }, [
    el('div', { class: 'cine-barcode', 'aria-hidden': 'true' }),
    el('div', { class: 'cine-code', text: `SHF-${String(data.tmdbId || '0000').slice(-4).padStart(4, '0')}` }),
  ]);

  return el('div', { class: 'cine-ticket' }, [top, tear, stub]);
}

// Miniature ticket for the My Tickets collection: the same paper, banner, tear
// notches and barcode at stub size, with the date the full ticket shows (the
// screening date, else the release date it falls back to). A button: the
// collection opens the full ticket on tap. Read-only, no fields.
// The banner goes through mountPoster like every grid poster: a shimmer until
// it decodes, and no fade at all when the backdrop is already in imageCache (My
// Tickets warms them), so a screenful of miniatures doesn't pop in one by one.
// autoDecode:false: the collection decodes the visible ones itself, in one batch.
// viaCache: a miss joins that warm-up's request rather than downloading again.
export function renderMiniTicket(ticketData) {
  const data = ticketData || {};
  return el('button', { class: 'cine-mini', type: 'button', 'aria-label': data.title || t('ticket.untitled') }, [
    el('div', { class: 'cine-mini-top' }, [
      mountPoster(el('div', { class: 'cine-mini-banner' }), data.backdropPath, '', {
        autoDecode: false,
        viaCache: true,
      }),
      el('div', { class: 'cine-mini-body' }, [
        el('div', { class: 'cine-mini-title', text: data.title || t('ticket.untitled') }),
        el('div', { class: 'cine-mini-date', text: formatDate(data.cinemaDate || data.releaseDate) }),
      ]),
    ]),
    el('div', { class: 'cine-mini-tear' }),
    el('div', { class: 'cine-mini-stub' }, [el('div', { class: 'cine-mini-barcode', 'aria-hidden': 'true' })]),
  ]);
}
