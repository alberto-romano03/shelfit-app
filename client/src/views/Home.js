// Home screen (/) — the profile landing page: cover, avatar, editable profile,
// watch-time stats, a "Currently watching" rail, custom lists, and the feature
// entry points (Back to the Shelf, Dust It Off, Rate-O-Matic, receipt). Paints
// instantly from a durable cache, then revalidates each piece from the network.

import { api, createApi, isAbortError } from '../api.js';
import { navigate, onCleanup, openDetail } from '../router.js';
import { openDustItOff } from '../dustItOff.js';
import { openReceipt } from '../receipt.js';
import { openRateOMatic } from '../rateOMatic.js';
import { openCinemaTickets } from '../cinemaTickets.js';
import { openShowcase } from '../showcase.js';
import { createTheWall } from '../theWall.js';
import { attachNowPlayingRing, detachNowPlayingRing } from '../nowPlaying.js';
import { getSharedShelfQueue, prefetchShelfQueues } from '../shelfQueue.js';
import { toggleTheme, resolvedTheme } from '../theme.js';
import {
  PK,
  pget,
  pset,
  pequal,
  persistImage,
  getWatching,
  persistWatching,
} from '../persist.js';
import {
  el,
  icons,
  poster,
  starSvg,
  cachedImg,
  cachedBlobImg,
  setBg,
  formatWatchTime,
  epLabel,
  openModal,
  toast,
  skelLine,
  segmentedControl,
  fadeSwap,
  lucideIcon,
} from '../ui.js';
import { imageCache } from '../imageCache.js';
import { isServerReachable, markDegraded } from '../network.js';
import { withBase } from '../basePath.js';
import { initSnow } from '../snow.js';
import { t, locale } from '../i18n.js';

// Decorative animated background for the two home CTAs. Inert markup (grey,
// low-opacity, CSS-@keyframes-animated) that lives *behind* the label as soft
// texture — never a foreground icon. See styles.css for the animations.
const DUST_STAR =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.3 7.4L22 12l-7.7 2.6L12 22l-2.3-7.4L2 12l7.7-2.6z"/></svg>';
// Six stars → an irregularly-scattered starfield; each star's size, position and
// fade timing is set in CSS (nth-child).
const DUST_ANIM = `<span class="btn-anim dust-anim" aria-hidden="true">${`<span class="dstar">${DUST_STAR}</span>`.repeat(
  6
)}</span>`;
// Back to the Shelf → a fixed grid of small squares. Each square fades in and
// out on its OWN randomized duration and start phase, so reveals are sparse,
// independent and uncoordinated — no wave, no pattern. Most squares sit at
// opacity 0 at any moment.
const SHELF_ANIM = (() => {
  const COLS = 16;
  const ROWS = 4;
  let cells = '';
  for (let i = 0; i < COLS * ROWS; i++) {
    const dur = (22 + Math.random() * 18).toFixed(2); // 22–40s, all different (very slow)
    const delay = (-(Math.random() * dur)).toFixed(2); // random starting phase
    cells += `<span class="sq" style="animation-duration:${dur}s;animation-delay:${delay}s"></span>`;
  }
  return `<span class="btn-anim shelf-anim" aria-hidden="true">${cells}</span>`;
})();
// Rate-O-Matic → hearts + five-pointed stars scattered as background texture,
// each fading independently (the same organic opacity treatment as Dust It Off).
// Size, position and timing are randomized per element in Home() after mount.
const ROM_ANIM = (() => {
  const N = 10;
  let cells = '';
  for (let i = 0; i < N; i++) {
    cells += `<span class="dstar">${i % 2 === 0 ? icons.heart : starSvg(true)}</span>`;
  }
  return `<span class="btn-anim rom-anim" aria-hidden="true">${cells}</span>`;
})();
// Lucide "disc-3" — the little disc mark inside each spine's blu-ray-style band.
const DISC3 =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M6 12c0-1.7.7-3.2 1.8-4.2"/><circle cx="12" cy="12" r="2"/><path d="M18 12c0 1.7-.7 3.2-1.8 4.2"/></svg>';

// Decorative potted plant, embedded inline so it needs no network request and
// stays crisp at any size (viewBox cropped to the artwork's bounds so it seats
// tight to the spines).
//
// Artwork: "Plant Garden 2" from SVG Repo's Garden collection
// (https://www.svgrepo.com/collection/garden/), uploaded by SVG Repo, released
// under the CC0 License (https://www.svgrepo.com/page/licensing/#CC0).
const PLANT_SVG =
  '<svg viewBox="50 0 412 512" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="#91cf96" d="M168.712,247.172C149.75,105.975,57.378,79.448,57.378,79.448C155.93,37.65,229.772,62.499,241.178,247.172H168.712z"/>' +
  '<path fill="#5aba63" d="M244.44,247.172h-3.24c-4.696-76.006-19.968-124.928-43.193-153.273C204.972,31.17,267.162,0,313.384,0c-16.94,16.931-42.567,43.352-44.006,133.42C256.993,160.035,247.998,196.89,244.44,247.172"/>' +
  '<path fill="#91cf96" d="M303.67,247.172h-59.207c19.827-280.47,209.028-143.122,210.158-141.241C377.168,105.931,323.082,178.45,303.67,247.172"/>' +
  '<polygon fill="#7f5b53" points="57.382,291.31 428.141,291.31 428.141,247.172 57.382,247.172"/>' +
  '<polygon fill="#7f5b53" points="384.003,512 101.52,512 92.692,476.69 392.83,476.69"/>' +
  '<polygon fill="#af8066" points="361.934,476.69 392.83,291.31 92.692,291.31 123.589,476.69"/>' +
  '<path fill="#d9aa94" d="M207.451,353.103h-8.828c-4.873,0-8.828-3.946-8.828-8.828c0-4.882,3.955-8.828,8.828-8.828h8.828c4.873,0,8.828,3.946,8.828,8.828C216.279,349.158,212.324,353.103,207.451,353.103"/>' +
  '<path fill="#d9aa94" d="M251.589,423.724h-8.828c-4.873,0-8.828-3.946-8.828-8.828c0-4.882,3.955-8.828,8.828-8.828h8.828c4.873,0,8.828,3.946,8.828,8.828C260.416,419.778,256.462,423.724,251.589,423.724"/>' +
  '<path fill="#d9aa94" d="M373.656,406.356c-0.486-0.079-0.918-0.291-1.421-0.291h-85.336c-4.873,0-8.828,3.955-8.828,8.828c0,4.882,3.955,8.828,8.828,8.828h83.862L373.656,406.356z"/>' +
  '<path fill="#d9aa94" d="M163.313,335.448H101.52c-0.503,0-0.945,0.203-1.421,0.291l2.895,17.364h60.319c4.873,0,8.828-3.946,8.828-8.828C172.141,339.394,168.186,335.448,163.313,335.448"/>' +
  '</svg>';

export default async function Home(container) {
  const ac = new AbortController();
  const cleanups = [() => ac.abort()];
  // One failing teardown must not strand the ones after it (observers, timers,
  // window listeners) — this is the only view whose cleanups are batched.
  onCleanup(() =>
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch {
        /* already-removed node / detached observer — nothing to do */
      }
    })
  );
  const api = createApi(ac.signal); // shadows the default client for load fetches

  // ------ 1) Ghost frame, rendered instantly ------
  let profileData = null; // filled when the profile request resolves

  const cover = el('div', { class: 'profile-cover' });

  // Theme toggle sits between edit and settings; icon reflects current theme.
  const themeBtn = el('button', {
    class: 'icon-btn cover-btn',
    'aria-label': t('home.toggleTheme'),
    html: resolvedTheme() === 'light' ? icons.moon : icons.sun,
  });
  themeBtn.addEventListener('click', () => {
    const next = toggleTheme();
    themeBtn.innerHTML = next === 'light' ? icons.moon : icons.sun;
  });

  // Edit + theme live on the cover; Settings moved to the top header bar. The
  // flex row shrinks to fit the two remaining buttons, so no gap is left behind.
  const overlay = el(
    'div',
    // The cover sits below the sticky app header, which already clears the notch
    // (its own safe-area-inset-top padding). So these buttons are offset a plain
    // 8px from the cover's top edge — adding the safe-area inset here again would
    // double-count it and push them down on iOS (but not on desktop, where the
    // inset is 0).
    { style: { position: 'absolute', top: '8px', right: '8px', zIndex: 3, display: 'flex', gap: '8px' } },
    [
      el('button', {
        class: 'icon-btn cover-btn edit-cover-btn',
        html: icons.userRoundPen,
        'aria-label': t('home.profile.edit'),
        onClick: () => profileData && openProfileModal(profileData, () => navigate('/')),
      }),
      themeBtn,
    ]
  );
  cover.append(overlay);

  // Feature-tour re-open button — mirrors the edit + theme buttons on the right,
  // sitting at the top-LEFT of the cover with the same round cover-button style.
  cover.append(
    el(
      'div',
      { style: { position: 'absolute', top: '8px', left: '8px', zIndex: 3, display: 'flex', gap: '8px' } },
      [
        el('button', {
          class: 'icon-btn cover-btn',
          html: icons.help,
          'aria-label': t('showcase.reopen'),
          onClick: openShowcase,
        }),
      ]
    )
  );

  // Seasonal snow (December only, user-toggleable). Renders below the button
  // overlay and the profile row; a no-op the rest of the year. Cleaned up on
  // navigate-away with the other home teardown callbacks.
  cleanups.push(initSnow(cover));

  // ---- Durable cache: paint last-known values instantly (no skeleton) ----
  // Read from localStorage, which survives an iOS PWA relaunch. For images we
  // keep the actual BYTES (a data: URL) so avatar/cover/badge render fully
  // offline, with no network and no dependency on the (evictable) SW cache.
  const cached = {
    name: pget(PK.name), // string | undefined
    avatarUrl: pget(PK.avatarUrl), // url | null | undefined
    avatarData: pget(PK.avatarData), // data: URL | undefined
    badgeUrl: pget(PK.badgeUrl), // url | null | undefined
    badgeData: pget(PK.badgeData), // data: URL | undefined
    coverUrl: pget(PK.coverUrl), // url | null | undefined
    coverData: pget(PK.coverData), // data: URL | undefined
    eps: pget(PK.statsEpisodes), // {time,est,count} | undefined
    movies: pget(PK.statsMovies), // {time,done} | undefined
  };

  // An <img> from persisted bytes (renders offline) when we have them; otherwise
  // the network-backed blob loader (which also works from the SW cache online).
  //
  // Persisted bytes are painted at full opacity with NO fade: a data: URL is
  // already on-device, so animating it would just replay a flash every time Home
  // is re-mounted on navigation. The avatar and badge therefore appear "stale"
  // (unchanged, instant) and are only repainted by the reconcile step below when
  // their source URL actually changes.
  function imgFromCache(dataUrl, url, props) {
    if (dataUrl) {
      const img = el('img', props);
      img.src = dataUrl;
      return img;
    }
    return cachedBlobImg(url, props);
  }

  function buildAvatar(dataUrl, url, name) {
    if (dataUrl || url) {
      const img = imgFromCache(dataUrl, url, { class: 'avatar', alt: t('home.profile.avatarAlt') });
      img.addEventListener('error', () => img.replaceWith(makeAvatarPlaceholder(name || '')));
      return img;
    }
    return makeAvatarPlaceholder(name || '');
  }
  // Avatar: persisted bytes, else cached-name initial, else empty placeholder.
  let avatar =
    cached.avatarData || cached.avatarUrl || cached.name !== undefined
      ? buildAvatar(cached.avatarData || null, cached.avatarUrl || null, cached.name || '')
      : makeAvatarPlaceholder('');

  function paintName(name, badgeData, badgeUrl) {
    nameRow.replaceChildren(
      el('span', { text: name }),
      badgeData || badgeUrl
        ? imgFromCache(badgeData, badgeUrl, { class: 'badge', alt: t('home.profile.badgeAlt') })
        : document.createComment('')
    );
  }
  const nameRow = el('div', { class: 'profile-name' });
  if (cached.name !== undefined) paintName(cached.name, cached.badgeData || null, cached.badgeUrl || null);
  else nameRow.append(skelLine({ width: '140px', height: '20px' }));

  // Wrap the avatar so the Kodi "Now Playing" ring (an absolutely-positioned
  // sibling) survives avatar replacement on profile updates and adds no layout
  // shift. The nowPlaying module mounts + drives the ring from cached state.
  const avatarWrap = el('div', { class: 'avatar-wrap' }, [avatar]);
  attachNowPlayingRing(avatarWrap);
  // Release the module-level handle on navigate-away so this avatar subtree
  // isn't retained as detached DOM while the user is on another page.
  cleanups.push(() => detachNowPlayingRing(avatarWrap));

  const profileRow = el('div', { class: 'profile-row' }, [avatarWrap, nameRow]);
  if (cached.coverData) cover.style.backgroundImage = `url("${cached.coverData}")`;
  else if (cached.coverUrl) setBg(cover, cached.coverUrl);

  // Counts read as one long run of digits without a separator (3457 vs 3,457).
  const statCount = (n) => Number(n || 0).toLocaleString(locale());

  // Stat cells: cached value if present, otherwise a skeleton to fill later.
  // Each cell carries a leading masked glyph in its palette ink (see .stat-ico),
  // with the value + label stacked to its right — tied to the stat, not position.
  const STAT_ICONS = {
    movies_time: 'clapperboard',
    shows_time: 'tv',
    movies_done: 'popcorn',
    eps: 'layers',
  };
  const statValueEls = {};
  function statCard(key, label, initialText) {
    const value =
      initialText != null
        ? el('div', { class: 'value', text: initialText })
        : el('div', { class: 'value' }, [skelLine({ width: '64px', height: '22px' })]);
    statValueEls[key] = value;
    return el('div', { class: 'stat-card' }, [
      lucideIcon(STAT_ICONS[key], 'stat-ico'),
      el('div', { class: 'stat-txt' }, [
        value,
        el('div', { class: 'label', text: label }),
      ]),
    ]);
  }
  const statsGrid = el('div', { class: 'stats-grid' }, [
    statCard('movies_time', t('home.stats.movieTime'), cached.movies ? formatWatchTime(cached.movies.time, false) : null),
    statCard('shows_time', t('home.stats.seriesTime'), cached.eps ? formatWatchTime(cached.eps.time, cached.eps.est) : null),
    statCard('movies_done', t('home.stats.moviesShelved'), cached.movies ? statCount(cached.movies.done) : null),
    statCard('eps', t('home.stats.episodesWatched'), cached.eps ? statCount(cached.eps.count) : null),
  ]);

  // --- Currently watching -------------------------------------------------
  // Paints instantly from a durable localStorage copy (metadata + poster bytes),
  // then revalidates from the network. The list changes seldom, so a just-added /
  // removed title reconciles on the next fetch — no ghost skeleton in between.
  function epText(it) {
    if (it.last_watched) return epLabel(it.last_watched.season, it.last_watched.episode);
    return it.type === 'movie' ? t('media.movie') : t('home.watching.notStarted');
  }
  function watchingCard(it) {
    // A persisted card carries its poster bytes (data: URL) → instant, no shimmer.
    // A fresh card uses the normal cached-image path (warmed above the fold below).
    const posterEl = it.posterData
      ? el('div', { class: 'poster-card' }, [
          el('img', { class: 'img-fade in', src: it.posterData, alt: it.title_it }),
        ])
      : poster(it.poster_url, it.title_it);
    const card = el('div', { class: 'watching-card' }, [
      posterEl,
      el('div', { class: 'wc-title', text: it.title_it }),
      el('div', { class: 'wc-ep', text: epText(it) }),
    ]);
    card.addEventListener('click', () => navigate(`/detail/${it.id}`));
    return card;
  }
  // Order-sensitive signature used to skip a needless re-render when nothing changed.
  function watchingSig(list) {
    return (list || [])
      .map(
        (i) =>
          `${i.id}:${i.type}:${i.poster_url}:${
            i.last_watched ? `${i.last_watched.season}-${i.last_watched.episode}` : ''
          }`
      )
      .join('|');
  }

  const section = el('div', {}, [el('div', { class: 'section-title', text: t('home.watching.title') })]);
  const cachedWatching = getWatching();
  let watchRow;
  if (Array.isArray(cachedWatching)) {
    // Durable copy exists → paint it immediately (real posters, no ghost).
    watchRow = cachedWatching.length
      ? el('div', { class: 'hscroll' }, cachedWatching.map(watchingCard))
      : el('div', { class: 'muted', text: t('home.watching.empty') });
  } else {
    // First ever launch (nothing cached) → the ghost skeleton.
    watchRow = el('div', { class: 'hscroll' });
    for (let i = 0; i < 4; i++) {
      watchRow.append(
        // Two lines to match the loaded card (title + episode) so the swap holds
        // its height and nothing below it jumps.
        el('div', { class: 'watching-card' }, [
          el('div', { class: 'poster-card skeleton' }),
          skelLine({ cls: 'sm', width: '90px', margin: '6px 0 0' }),
          skelLine({ cls: 'sm', width: '60px', margin: '5px 0 0' }),
        ])
      );
    }
  }
  section.append(watchRow);

  // --- Custom lists (filled from the server; empty lists stay hidden) ---
  const listsContainer = el('div', { class: 'home-lists' });

  // --- Rediscover Your Collection (title + animated-arrows button) ---
  const rediscover = el('div', {}, [
    el('div', { class: 'section-title', text: t('home.backToShelf') }),
    el('button', {
      class: 'rediscover-btn shelf-btn',
      html: `${SHELF_ANIM}<span class="rediscover-label">${t('home.shelfCta')}</span>`,
      onClick: openRediscoverModal,
    }),
  ]);

  // --- Dust It Off (mood-based suggestion, animated-starfield button) ---
  const dust = el('div', {}, [
    el('div', { class: 'section-title', text: t('home.dustItOff') }),
    el('button', {
      class: 'rediscover-btn dust-btn',
      html: `${DUST_ANIM}<span class="rediscover-label">${t('home.dustCta')}</span>`,
      onClick: openDustItOff,
    }),
  ]);

  // Each star relocates to a fresh random spot every time it fades back in. The
  // move fires on animationiteration — the cycle boundary where opacity is 0 —
  // so the reposition is never visible; the star just reappears elsewhere.
  const placeStar = (s) => {
    s.style.left = (Math.random() * 88).toFixed(1) + '%';
    s.style.top = (Math.random() * 60).toFixed(1) + '%';
  };
  // The exact per-star setup, extracted so both the Dust It Off button and the
  // experimental Counter slot below drive the same animation with no duplication.
  const initDustStar = (s) => {
    placeStar(s);
    s.addEventListener('animationiteration', () => placeStar(s));
  };
  dust.querySelectorAll('.dstar').forEach(initDustStar);

  // --- Rate-O-Matic (matches the Back to the Shelf / Dust It Off buttons) ---
  const rate = el('div', {}, [
    el('div', { class: 'section-title', text: 'Rate-O-Matic' }),
    el('button', {
      class: 'rediscover-btn rom-btn',
      html: `${ROM_ANIM}<span class="rediscover-label">${t('home.rateCta')}</span>`,
      onClick: openRateOMatic,
    }),
  ]);
  // Scatter the hearts/stars: size + fade timing set once; position randomized
  // now and re-randomized whenever an element has faded back to zero opacity.
  const placeRomIcon = (s) => {
    s.style.left = (Math.random() * 86).toFixed(1) + '%';
    s.style.top = (Math.random() * 60).toFixed(1) + '%';
  };
  // The exact per-icon setup (size + timing + placement), extracted so both the
  // Rate-O-Matic button and the Counter slot reuse it without duplicating logic.
  const initRomIcon = (s) => {
    const size = (16 + Math.random() * 18).toFixed(0); // 16–34px, varied
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.animationDuration = (3.2 + Math.random() * 2.6).toFixed(2) + 's';
    s.style.animationDelay = (-Math.random() * 5).toFixed(2) + 's';
    placeRomIcon(s);
    s.addEventListener('animationiteration', () => placeRomIcon(s));
  };
  rate.querySelectorAll('.dstar').forEach(initRomIcon);

  // --- Experiment: "The Shelf" — three DVD/VHS spines standing upright on a
  // physical shelf. Purely additive: the three individual buttons above are
  // untouched. Each spine reuses the very same animation markup (SHELF_ANIM /
  // DUST_ANIM / ROM_ANIM) and the same init helpers as the buttons — no new
  // animation logic. Tapping a spine plays a brief CSS "extraction" (slides up)
  // then opens the function. ---
  // `animHtml` is still accepted (and still passed by the call sites below) but
  // no longer rendered: the flat restyle dropped the faint animated artwork that
  // used to sit behind each title. Uncomment the .dvd-spine-anim line — and the
  // matching rule in styles.css — to bring it back.
  const spine = (labelText, animHtml, cls, onClick) => {
    const s = el('button', { class: `dvd-spine ${cls}`, onClick: null }, [
      el('span', { class: 'dvd-spine-band', html: `${DISC3}<span class="dvd-spine-brand">shelfit</span>` }),
      // el('span', { class: 'dvd-spine-anim', html: animHtml }),
      el('span', { class: 'dvd-spine-label' }, [
        // Inner span so the rotation sits on the TEXT, not on the centring box
        // (see .dvd-spine-label in styles.css).
        el('span', { class: 'dvd-spine-label-text', text: labelText }),
      ]),
    ]);
    // Play the ~200ms extraction, then open the function.
    s.addEventListener('click', () => {
      if (s.classList.contains('extracting')) return;
      s.classList.add('extracting');
      setTimeout(() => {
        s.classList.remove('extracting');
        onClick();
      }, 200);
    });
    return s;
  };
  // Decorative potted plant standing on the shelf, to the left of the boxsets.
  // Inline SVG (no network request, scales crisply on any display) instead of the
  // old raster image.
  const plant = el('div', { class: 'dvd-plant', 'aria-hidden': 'true', html: PLANT_SVG });
  const shelf = el('div', {}, [
    el('div', { class: 'section-title', text: t('home.theShelf') }),
    el('div', { class: 'dvd-shelf' }, [
      el('div', { class: 'dvd-spines' }, [
        plant,
        spine(t('home.backToShelf'), SHELF_ANIM, 'spine-shelf', openRediscoverModal),
        spine(t('home.dustItOff'), DUST_ANIM, 'spine-dust', openDustItOff),
        spine('Rate-O-Matic', ROM_ANIM, 'spine-rom', openRateOMatic),
      ]),
      el('div', { class: 'dvd-shelf-surface' }),
    ]),
  ]);
  // Retired with the spine artwork above — these would now match nothing.
  // Restore alongside the .dvd-spine-anim line in spine().
  // shelf.querySelectorAll('.dust-anim .dstar').forEach(initDustStar);
  // shelf.querySelectorAll('.rom-anim .dstar').forEach(initRomIcon);

  // --- Monthly Rental Receipt (minimal entry → full-screen customizer) ---
  const receiptEntry = el('button', {
    class: 'rcpt-entry',
    html: `${icons.receipt}<span>${t('home.receiptEntry')}</span>${icons.chevron}`,
    onClick: openReceipt,
  });

  // Experiment: a POS thermal-printer widget as an ADDITIONAL entry point to the
  // same receipt modal. Purely additive — the minimal button above is untouched.
  // Pure CSS/markup (no images/canvas); tapping anywhere opens openReceipt.
  const posPrinter = el('button', {
    class: 'pos-printer',
    'aria-label': t('home.receiptOpen'),
    onClick: openReceipt,
    html: `
      <span class="pos-body">
        <span class="pos-label">${t('home.receiptLabel')}</span>
        <span class="pos-slot" aria-hidden="true"></span>
      </span>
      <span class="pos-paper" aria-hidden="true"><span class="pos-paper-sheet"></span></span>`,
  });

  // --- The Desk ------------------------------------------------------------
  // A named home section grouping two entry points: a wooden "drawer" that opens
  // the cinema ticket collection, above the POS-printer receipt widget.
  const drawer = el('button', {
    class: 'desk-drawer',
    'aria-label': t('home.desk.openTickets'),
    html: '<span class="desk-drawer-face"><span class="desk-knob" aria-hidden="true"></span></span>',
    onClick: () => {
      // CSS-only pull-open (translateY on the drawer face); open the modal once
      // the brief slide finishes, then reset the drawer behind it.
      drawer.classList.add('opening');
      setTimeout(() => {
        drawer.classList.remove('opening');
        openCinemaTickets();
      }, 240);
    },
  });
  const theDesk = el('div', { class: 'the-desk' }, [
    el('div', { class: 'section-title', text: t('home.desk.title') }),
    drawer,
    posPrinter,
  ]);

  // Experiment: the three feature entry points are now shown via the DVD-spine
  // "Shelf" below. The original individual buttons (`rediscover`, `dust`, `rate`)
  // are still fully built above — so their reused animations and the idle-glow
  // logic keep working — but are intentionally NOT appended here, hiding them.
  // To bring the originals back, just add `rediscover, dust, rate,` to this list.
  // The original minimal receipt button (`receiptEntry`) is still built above but
  // intentionally NOT appended here — hidden in favour of the POS-printer widget
  // (now nested under The Desk). To bring it back, add `receiptEntry,` to this list.
  const theWall = createTheWall();
  container.append(cover, profileRow, statsGrid, section, listsContainer, /* rediscover, dust, rate, */ shelf, /* receiptEntry, */ theDesk, theWall);

  // First launch only: introduce the app with the feature showcase, exactly once.
  // The flag is set immediately (not on finish) so a reload mid-tour won't reopen
  // it; the header "?" button reopens it any time thereafter. A short delay lets
  // the home paint settle behind the sheet so it slides up over real content.
  if (pget(PK.showcaseSeen) === undefined) {
    pset(PK.showcaseSeen, true);
    const showcaseTimer = setTimeout(openShowcase, 400);
    cleanups.push(() => clearTimeout(showcaseTimer));
  }

  // Play the receipt "print out" the moment the printer scrolls into view — it
  // sits near the bottom of the page, so a mount-time CSS animation would finish
  // unseen before the user scrolls down to it. A timeout is a safety fallback so
  // the receipt is never left hidden if the observer never fires.
  const printOut = () => posPrinter.classList.add('printed');
  const printFallback = setTimeout(printOut, 4000);
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          printOut();
          io.disconnect();
          clearTimeout(printFallback);
        }
      },
      { threshold: 0.35 }
    );
    io.observe(posPrinter);
    cleanups.push(() => io.disconnect());
  } else {
    printOut();
  }
  cleanups.push(() => clearTimeout(printFallback));

  // Each custom list → a card: poster collage background, dark overlay, name
  // bottom-left, and a type icon top-right on a small accent disc. The glyphs
  // are the navbar's own clapperboard and TV, so a list's type reads the same
  // here as it does in the tab bar.
  function buildListCard(l) {
    const collage = el('div', { class: 'list-collage' });
    const covers = (l.preview || []).filter((it) => it.poster_url).slice(0, 4);
    covers.forEach((it) => collage.append(cachedImg(it.poster_url, { class: 'list-collage-img', alt: '' })));
    const card = el('div', { class: 'list-card' + (covers.length ? '' : ' no-covers') }, [
      collage,
      el('div', { class: 'list-card-overlay' }),
      el('div', {
        class: 'list-type-disc',
        html: l.type === 'movie' ? icons.navMovies : icons.navSeries,
      }),
      el('div', { class: 'list-card-name', text: l.name }),
    ]);
    card.addEventListener('click', () => navigate(`/list/${l.id}`));
    return card;
  }

  // ------ Custom list cards (horizontally scrollable) ------
  api
    .lists()
    .then((data) => {
      const lists = (data.lists || []).filter((l) => l.count > 0);
      listsContainer.innerHTML = '';
      if (!lists.length) return;
      imageCache.preload(
        lists.flatMap((l) => (l.preview || []).map((it) => it.poster_url)).filter(Boolean)
      );
      const row = el('div', { class: 'hscroll list-card-row' });
      lists.forEach((l) => row.append(buildListCard(l)));
      listsContainer.append(el('div', { class: 'section-title', text: t('home.myLists') }), row);
    })
    .catch((err) => {
      if (isAbortError(err)) return;
      if (!isServerReachable()) markDegraded(); // recover on reconnect
      listsContainer.innerHTML = '';
    });

  // ------ Idle border-draw: after a few idle seconds a glowing orange stroke
  // paints itself around the shelf button, pauses, then the Dust It Off button;
  // both glows fade out together, wait, and repeat. Any interaction stops it. --
  const shelfGlowBtn = rediscover.querySelector('.rediscover-btn');
  const dustGlowBtn = dust.querySelector('.rediscover-btn');
  const romGlowBtn = rate.querySelector('.rediscover-btn');
  const glowBtns = [shelfGlowBtn, dustGlowBtn, romGlowBtn];
  glowBtns.forEach(addBorderOverlay);

  let idleTimer = null;
  const cycleTimers = [];
  function stopIdle() {
    clearTimeout(idleTimer);
    cycleTimers.splice(0).forEach(clearTimeout);
    glowBtns.forEach((b) => b.classList.remove('idle-draw', 'idle-lit', 'idle-out'));
  }
  function runCycle() {
    // Each button's orange stroke draws in turn (~2s each), then all three fade
    // out together, reset, and the cycle repeats after a pause.
    shelfGlowBtn.classList.add('idle-draw', 'idle-lit');
    cycleTimers.push(setTimeout(() => dustGlowBtn.classList.add('idle-draw', 'idle-lit'), 2200));
    cycleTimers.push(setTimeout(() => romGlowBtn.classList.add('idle-draw', 'idle-lit'), 4400));
    cycleTimers.push(
      setTimeout(() => glowBtns.forEach((b) => {
        b.classList.remove('idle-lit');
        b.classList.add('idle-out');
      }), 6400)
    );
    cycleTimers.push(
      setTimeout(() => glowBtns.forEach((b) => b.classList.remove('idle-draw', 'idle-out')), 7200)
    );
    cycleTimers.push(setTimeout(runCycle, 10500));
  }
  function armIdle() {
    stopIdle();
    idleTimer = setTimeout(runCycle, 4000);
  }
  const idleEvents = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
  idleEvents.forEach((e) => window.addEventListener(e, armIdle, { passive: true }));
  armIdle();
  cleanups.push(() => {
    stopIdle();
    idleEvents.forEach((e) => window.removeEventListener(e, armIdle));
  });

  // ------ 2) Fetch fresh in parallel; reconcile with the cached values ------
  // Only touch the DOM (and rewrite the cache) for pieces that actually changed,
  // so unchanged data causes no flash and no re-render.
  api
    .profile()
    .then((profile) => {
      profileData = profile;
      const name = profile.display_name;
      const avatarUrl = profile.profile_image_url || null;
      const badgeUrl = profile.active_badge_url || null;
      const coverUrl = profile.cover_image_url || null;

      // Name + badge share nameRow, so repaint together if either changed. Reuse
      // any already-persisted badge bytes until persistImage() refreshes them.
      if (name !== cached.name || badgeUrl !== cached.badgeUrl) {
        paintName(name, cached.badgeData || null, badgeUrl);
        cached.name = name;
        cached.badgeUrl = badgeUrl;
        pset(PK.name, name);
        pset(PK.badgeUrl, badgeUrl);
      }
      if (avatarUrl !== cached.avatarUrl) {
        const next = buildAvatar(null, avatarUrl, name);
        avatar.replaceWith(next);
        avatar = next;
        cached.avatarUrl = avatarUrl;
        pset(PK.avatarUrl, avatarUrl);
      }
      if (coverUrl !== cached.coverUrl) {
        if (coverUrl) setBg(cover, coverUrl);
        else cover.style.backgroundImage = '';
        cached.coverUrl = coverUrl;
        pset(PK.coverUrl, coverUrl);
      }

      // Persist the image BYTES for the next (possibly offline) launch. Keyed by
      // source URL, so this refetches only when an image actually changed.
      persistImage(PK.avatarData, avatarUrl);
      persistImage(PK.coverData, coverUrl);
      persistImage(PK.badgeData, badgeUrl);
    })
    .catch((err) => {
      if (isAbortError(err)) return;
      if (!isServerReachable()) markDegraded();
      // Only show the fallback when we had nothing cached to display (the service
      // worker normally serves the last profile, so this rarely triggers).
      if (cached.name === undefined) {
        nameRow.replaceChildren(el('span', { text: t('home.profile.fallbackName') }));
      }
    });

  api
    .stats()
    .then((stats) => {
      const movies = {
        time: stats.total_minutes_movies || 0,
        done: stats.total_movies_completed || 0,
      };
      const eps = {
        time: stats.total_minutes_shows || 0,
        est: !!stats.is_estimated,
        count: stats.total_episodes_watched || 0,
      };
      if (!pequal(movies, cached.movies)) {
        statValueEls.movies_time.textContent = formatWatchTime(movies.time, false);
        statValueEls.movies_done.textContent = statCount(movies.done);
        cached.movies = movies;
        pset(PK.statsMovies, movies);
      }
      if (!pequal(eps, cached.eps)) {
        statValueEls.shows_time.textContent = formatWatchTime(eps.time, eps.est);
        statValueEls.eps.textContent = statCount(eps.count);
        cached.eps = eps;
        pset(PK.statsEpisodes, eps);
      }
    })
    .catch((err) => {
      if (isAbortError(err)) return;
      if (!isServerReachable()) markDegraded();
      if (!cached.movies && !cached.eps) {
        Object.values(statValueEls).forEach((v) => (v.textContent = '—'));
      }
    });

  api
    .media('?status=watching')
    .then((watching) => {
      const items = (watching.items || []).filter((i) => i.type === 'show' || i.type === 'movie');
      // Nothing changed since the durable copy → leave the instantly-painted cards
      // in place (no flash), and don't re-persist.
      if (Array.isArray(cachedWatching) && watchingSig(items) === watchingSig(cachedWatching)) {
        return;
      }
      if (!items.length) {
        watchRow.replaceWith(el('div', { class: 'muted', text: t('home.watching.empty') }));
        persistWatching([]); // remember the empty state
        return;
      }
      // Proactively warm these above-the-fold posters.
      imageCache.preload(items.map((i) => i.poster_url).filter(Boolean));
      const row = el('div', { class: 'hscroll' }, items.map(watchingCard));
      watchRow.replaceWith(row);
      watchRow = row;
      // Store the list + poster bytes so the next launch paints instantly.
      persistWatching(items);
    })
    .catch((err) => {
      if (isAbortError(err)) return;
      if (!isServerReachable()) {
        // Server unreachable (transport failure OR a 5xx from the reverse proxy
        // while the backend is down) → keep whatever is painted (cached cards or
        // the ghost); recover on reconnect. A 4xx falls through to the error below.
        markDegraded();
        return;
      }
      // Only surface an error when there's no durable copy already on screen.
      if (!Array.isArray(cachedWatching)) {
        watchRow.replaceWith(el('div', { class: 'muted', text: t('home.watching.loadError') }));
      }
    });

  // ------ Silently warm the "Back to the Shelf" queue in the background ------
  // The above fetches (profile/stats/watching/lists) are already dispatched;
  // schedule the shelf prefetch at idle priority so it neither blocks the render
  // nor competes with those calls. When the user opens the popup, the queue is
  // usually already warm → it opens instantly. If not, the popup falls back to
  // its normal loading state. Cancel it if the user leaves Home before it fires.
  const scheduleIdle = window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : (fn) => setTimeout(fn, 200);
  const cancelIdle = window.requestIdleCallback
    ? window.cancelIdleCallback.bind(window)
    : clearTimeout;
  // Warm BOTH shelf queues (movies + shows) in parallel while the home is idle.
  const idleHandle = scheduleIdle(() => prefetchShelfQueues());
  cleanups.push(() => cancelIdle(idleHandle));
}

// Append an SVG rounded-rect that traces the button's border. pathLength=100
// lets the CSS stroke-dashoffset animation run 100→0 regardless of button size.
function addBorderOverlay(btn) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'idle-border-svg');
  // No viewBox: the SVG user-space equals the button's pixel box, so rx is a
  // true 14px radius (matching the button) with no aspect-ratio distortion.
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('class', 'idle-border-rect');
  rect.setAttribute('x', '0');
  rect.setAttribute('y', '0');
  rect.setAttribute('width', '100%');
  rect.setAttribute('height', '100%');
  rect.setAttribute('rx', '14');
  rect.setAttribute('pathLength', '100');
  svg.append(rect);
  btn.append(svg);
}

function makeAvatarPlaceholder(name) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return el('div', { class: 'avatar avatar-placeholder', text: initial });
}

// --- Profile customization modal -----------------------------------------
// Keep long favourite-poster grids from making the Edit-profile modal huge:
// show at most `limit` cells, hide the rest behind a "Show all N" toggle. The
// currently-selected cell is always kept visible so the active choice never
// disappears. Returns a toggle button to place under the grid, plus refresh()
// to re-apply after cells are added (e.g. a freshly uploaded custom photo).
function collapsibleGrid(grid, limit) {
  let expanded = false;
  const toggle = el('button', {
    class: 'link-btn collapse-toggle',
    style: { display: 'none' },
  });
  function apply() {
    const cells = Array.from(grid.querySelectorAll('.sel'));
    if (cells.length <= limit) {
      toggle.style.display = 'none';
      cells.forEach((c) => (c.style.display = ''));
      return;
    }
    toggle.style.display = '';
    cells.forEach((cell, i) => {
      const keep = expanded || i < limit || cell.classList.contains('active');
      cell.style.display = keep ? '' : 'none';
    });
    toggle.textContent = expanded ? t('home.profile.showFewer') : t('home.profile.showAll', { n: cells.length });
  }
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    apply();
  });
  return { toggle, refresh: apply };
}

async function openProfileModal(profile, onSaved) {
  let badges = { badges: [] };
  let favorites = { items: [] };
  // Independent deps: a failure of one must not drop the other (or blank the
  // modal — name editing always survives). allSettled keeps each success.
  const [badgesRes, favoritesRes] = await Promise.allSettled([
    api.badges(),
    api.favoriteTitles(),
  ]);
  if (badgesRes.status === 'fulfilled' && badgesRes.value) badges = badgesRes.value;
  if (favoritesRes.status === 'fulfilled' && favoritesRes.value) favorites = favoritesRes.value;

  const state = {
    display_name: profile.display_name,
    profile_image: profile.profile_image || null,
    cover_image: profile.cover_image || null,
    active_badge: profile.active_badge || null,
  };

  openModal((modal, close) => {
    const nameField = el('input', {
      class: 'text-field',
      type: 'text',
      value: state.display_name,
    });

    // Profile photo: custom upload + grid of favourited posters.
    const fileInput = el('input', {
      type: 'file',
      accept: 'image/*',
      style: { display: 'none' },
    });
    const photoGrid = el('div', { class: 'select-grid' });

    let customCell = null;
    function selectCustom() {
      state.profile_image = 'custom';
      photoGrid.querySelectorAll('.sel').forEach((c) => c.classList.remove('active'));
      if (customCell) customCell.classList.add('active');
    }
    function buildCustomCell(url) {
      const cell = el(
        'div',
        { class: 'sel' + (state.profile_image === 'custom' ? ' active' : '') },
        [cachedImg(url, { alt: t('home.profile.customPhotoAlt') })]
      );
      cell.addEventListener('click', selectCustom);
      return cell;
    }
    if (profile.has_custom_photo) {
      customCell = buildCustomCell(`/api/profile/photo?v=${Date.now()}`);
      photoGrid.append(customCell);
    }

    for (const t of favorites.items) {
      const cell = el('div', { class: 'sel' + (state.profile_image === t.token ? ' active' : '') }, [
        cachedImg(t.poster_url, { alt: t.title_it }),
      ]);
      cell.addEventListener('click', () => {
        state.profile_image = t.token;
        photoGrid.querySelectorAll('.sel').forEach((c) => c.classList.remove('active'));
        cell.classList.add('active');
      });
      photoGrid.append(cell);
    }
    if (!favorites.items.length && !profile.has_custom_photo) {
      photoGrid.append(
        el('div', { class: 'muted', text: t('home.profile.noPhotos') })
      );
    }
    const photoCollapse = collapsibleGrid(photoGrid, 9);
    photoCollapse.refresh();

    const uploadBtn = el('button', {
      class: 'btn btn-secondary',
      html: `${icons.imageUp}<span class="upload-label" style="margin-left:8px">${t('home.profile.uploadPhoto')}</span>`,
      onClick: () => fileInput.click(),
    });
    const uploadLabel = uploadBtn.querySelector('.upload-label');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        toast(t('home.profile.notImage'), 'bad');
        return;
      }
      if (file.size > 12 * 1024 * 1024) {
        toast(t('home.profile.tooLarge'), 'bad');
        return;
      }
      uploadBtn.disabled = true;
      const label = uploadLabel.textContent;
      uploadLabel.textContent = t('home.profile.uploading');
      try {
        await api.uploadProfilePhoto(file);
        const url = `/api/profile/photo?v=${Date.now()}`;
        if (!customCell) {
          customCell = buildCustomCell(url);
          photoGrid.prepend(customCell);
          photoCollapse.refresh();
        } else {
          customCell.querySelector('img').src = withBase(url);
        }
        selectCustom();
        toast(t('home.profile.uploaded'), 'ok');
      } catch (err) {
        toast(err.message || t('home.profile.uploadFailed'), 'bad');
      } finally {
        uploadBtn.disabled = false;
        uploadLabel.textContent = label;
      }
    });
    const uploadRow = el('div', { class: 'stack', style: { marginBottom: '10px' } }, [
      uploadBtn,
      fileInput,
    ]);

    // Cover grid (backdrops) — 2 columns since backdrops are landscape. Only
    // favourited titles are offered here.
    const coverGrid = el('div', { class: 'select-grid cover-grid' });
    for (const t of favorites.items) {
      const cell = el('div', { class: 'sel cover' + (state.cover_image === t.token ? ' active' : '') }, [
        cachedImg(t.backdrop_url, { alt: t.title_it }),
      ]);
      cell.addEventListener('click', () => {
        state.cover_image = t.token;
        coverGrid.querySelectorAll('.sel').forEach((c) => c.classList.remove('active'));
        cell.classList.add('active');
      });
      coverGrid.append(cell);
    }
    if (!favorites.items.length) {
      coverGrid.append(
        el('div', { class: 'muted', text: t('home.profile.noCovers') })
      );
    }
    const coverCollapse = collapsibleGrid(coverGrid, 6);
    coverCollapse.refresh();

    // Badge grid ("No badge" first)
    const badgeGrid = el('div', { class: 'badge-grid' });
    const noBadge = el('div', {
      class: 'bsel bsel-none' + (!state.active_badge ? ' active' : ''),
      html: icons.badgeX,
      'aria-label': t('home.profile.noBadge'),
      title: t('home.profile.noBadge'),
    });
    noBadge.addEventListener('click', () => {
      state.active_badge = null;
      badgeGrid.querySelectorAll('.bsel').forEach((c) => c.classList.remove('active'));
      noBadge.classList.add('active');
    });
    badgeGrid.append(noBadge);
    for (const b of badges.badges) {
      const cell = el('div', { class: 'bsel' + (state.active_badge === b.filename ? ' active' : '') }, [
        cachedImg(b.url, { alt: b.filename }),
      ]);
      cell.addEventListener('click', () => {
        state.active_badge = b.filename;
        badgeGrid.querySelectorAll('.bsel').forEach((c) => c.classList.remove('active'));
        cell.classList.add('active');
      });
      badgeGrid.append(cell);
    }

    const saveBtn = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('check', 'btn-lucide'),
      el('span', { text: t('common.save') }),
    ]);
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await api.updateProfile({
          display_name: nameField.value.trim() || state.display_name,
          profile_image: state.profile_image,
          cover_image: state.cover_image,
          active_badge: state.active_badge || '',
        });
        close();
        toast(t('home.profile.updated'), 'ok');
        if (onSaved) onSaved();
      } catch (err) {
        saveBtn.disabled = false;
        toast(err.message || t('home.profile.saveFailed'), 'bad');
      }
    });

    // The photo, cover and badge grids make this a long form, so the actions are
    // pinned (as in the Kodi instance form): the body scrolls under the rule.
    modal.classList.add('modal--split');
    modal.append(
      el('div', { class: 'modal-body' }, [
        el('h3', { text: t('home.profile.edit') }),
        el('div', { class: 'field-label', text: t('home.profile.displayName') }),
        nameField,
        el('div', { class: 'field-label', text: t('home.profile.photo') }),
        uploadRow,
        photoGrid,
        photoCollapse.toggle,
        el('div', { class: 'field-label', text: t('home.profile.cover') }),
        coverGrid,
        coverCollapse.toggle,
        el('div', { class: 'field-label', text: t('home.profile.badge') }),
        badgeGrid,
      ]),
      el('div', { class: 'modal-foot' }, [
        el('hr', { class: 'status-sep' }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: close }, [
            lucideIcon('x', 'btn-lucide'),
            el('span', { text: t('common.cancel') }),
          ]),
          saveBtn,
        ]),
      ])
    );
  });
}

// --- Back to the Shelf: transition timings --------------------------------
// Every duration/easing the popup animates with lives here so the feel can be
// tuned without reading the frame loop.
//
// Two DISTINCT transitions, deliberately different in kind:
//   • SHUFFLE — the disc spins up, motion-blurs, and crossfades its art at the
//     peak. Nothing fades out; it reads as the same object being re-skinned.
//   • TYPE SWITCH — the whole card fades and scales away, then the new type's
//     card fades and scales back in. It reads as a mode change, not a re-skin.
const RD_BASE_SPEED = 18; // deg/sec — the idle turn (~20s per rotation)
const RD_BURST_SPEED = 900; // deg/sec — peak while shuffling
const RD_BURST_BLUR = 1; // px — peak motion blur at mid-burst
const RD_BURST_MS = 720; // accelerate → swap → decelerate
const RD_BURST_COMMIT_AT = 0.5; // burst fraction where art/chrome/meta all swap
const RD_ART_FADE_FROM = 0.25; // burst fraction where the incoming art starts fading
const RD_ART_FADE_SPAN = 0.45; // …over this fraction of the burst
const RD_SWITCH_MS = 280; // type switch — each half (exit, then enter)
const RD_SWITCH_SCALE = 0.92; // how far the card shrinks while away

// --- Rediscover Your Collection modal -------------------------------------
// Backed by a prefetch queue (shelfQueue). The shared queue is warmed in the
// background on home load, so the first open is normally instant; if it hasn't
// finished, the first title briefly skeletons. Every shuffle after is instant
// because the next titles and their disc/poster images are already loaded.
function openRediscoverModal() {
  // Warm BOTH types' queues in parallel the moment the popup opens, so toggling
  // to the other type finds its first title — and its image, already through
  // imageCache — sitting ready. (They are also warmed on home idle; ensureLoaded
  // makes the second call a no-op.)
  prefetchShelfQueues();
  const state = { type: 'movie' };
  // Each type has its own independent queue, replenished independently as the
  // user shuffles within that type.
  const queue = () => getSharedShelfQueue(state.type);
  let renderToken = 0;

  openModal((modal, close) => {
    // Movies / TV Shows. Both queues are already warm, so this is a presentation
    // change only — see switchType(). The shared segmented control is the app's
    // default for this kind of choice.
    const typeSeg = segmentedControl({
      options: [
        ['movie', t('media.movies')],
        ['show', t('media.tvShows')],
      ],
      value: state.type,
      ariaLabel: t('home.shelf.libraryType'),
      center: true,
      onChange: (key) => {
        // A switch already in flight owns the card; put the chip back and wait.
        if (switching) {
          typeSeg.set(state.type);
          return;
        }
        state.type = key;
        switchType();
      },
    });
    const toggle = typeSeg.el;

    // The CD: two stacked art layers (for crossfading old→new on shuffle), the
    // cover-art label, hub + hole, and a fixed glare. Rotation is JS-driven so a
    // shuffle can briefly spin the disc faster.
    const cdLabel = el('div', { class: 'cd-label' });
    const cdArtA = el('div', { class: 'cd-art' });
    const cdArtB = el('div', { class: 'cd-art' });
    const cd = el('div', { class: 'cd' }, [
      cdArtA,
      cdArtB,
      cdLabel,
      el('div', { class: 'cd-hub' }),
      el('div', { class: 'cd-hole' }),
    ]);
    const stage = el('div', { class: 'cd-stage' }, [cd, el('div', { class: 'cd-glare' })]);
    // A plain wrapper the type switch can fade + scale. It cannot live on
    // .cd-stage itself: that element runs the cd-float keyframes, and a running
    // animation owns `transform`, so a scale set there would be ignored.
    const switchWrap = el('div', { class: 'rd-switch-wrap' }, [stage]);

    const titleEl = el('div', { class: 'cd-title' });
    const subEl = el('div', { class: 'cd-sub' });
    const meta = el('div', { class: 'cd-meta' }, [titleEl, subEl]);

    const shuffleBtn = el('button', {
      class: 'btn btn-primary',
      html: `${icons.shuffle}<span style="margin-left:8px">${t('home.shelf.shuffle')}</span>`,
      onClick: () => doShuffle(),
    });

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // --- JS-driven rotation with a shuffle "speed burst" -------------------
    // On shuffle the disc accelerates its normal forward spin, blurs, crossfades
    // (timings are the RD_* constants above the modal)

    let currentLayer = cdArtA;
    const otherLayer = () => (currentLayer === cdArtA ? cdArtB : cdArtA);

    let angle = 0;
    let lastTs = null;
    let rafId = null;
    let burst = null; // { start, mode, inc, token, committed }

    function setChrome(mode) {
      cd.classList.toggle('has-full', mode === 'disc');
      cd.classList.toggle('cover-full', mode === 'cover');
    }
    function setLayerImage(layer, url, token) {
      imageCache.load(url).then((u) => {
        if (token === renderToken) layer.style.backgroundImage = `url("${u || url}")`;
      });
    }

    function frame(ts) {
      if (!cd.isConnected) {
        rafId = null;
        return; // modal closed — stop the loop
      }
      if (lastTs == null) lastTs = ts;
      let dt = (ts - lastTs) / 1000;
      lastTs = ts;
      if (dt > 0.05) dt = 0.05; // clamp big gaps (throttled background tab)

      let speed = RD_BASE_SPEED;
      let blur = 0;
      if (burst) {
        if (burst.start == null) burst.start = ts;
        const t = (ts - burst.start) / RD_BURST_MS;
        if (t >= 1) {
          currentLayer.style.opacity = '0'; // old art fully hidden now
          currentLayer = burst.inc; // incoming becomes current
          burst = null;
        } else {
          const bump = Math.sin(Math.PI * t); // 0 → 1 → 0 (accelerate/decelerate)
          speed = RD_BASE_SPEED + (RD_BURST_SPEED - RD_BASE_SPEED) * bump;
          blur = RD_BURST_BLUR * bump;
          // Crossfade the incoming art in over the middle of the burst.
          burst.inc.style.opacity = String(
            Math.max(0, Math.min(1, (t - RD_ART_FADE_FROM) / RD_ART_FADE_SPAN))
          );
          if (!burst.committed && t >= RD_BURST_COMMIT_AT) {
            setChrome(burst.mode); // swap disc chrome under peak blur
            // The title/year/stars swap HERE, at the blur peak, together with the
            // art — not when the shuffle was requested. Updating them up front
            // meant the new title was already on screen while the disc was still
            // showing the old cover for the rest of the 720ms burst.
            if (burst.item) fadeSwap(meta, () => setMeta(burst.item));
            burst.committed = true;
          }
        }
      }

      angle = (angle + speed * dt) % 360;
      cd.style.transform = `rotate(${angle}deg)`;
      const f = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : '';
      if (cd.style.filter !== f) cd.style.filter = f;
      rafId = requestAnimationFrame(frame);
    }
    function startSpin() {
      if (reduceMotion || rafId != null) return;
      lastTs = null;
      rafId = requestAnimationFrame(frame);
    }

    function artOf(item) {
      const fa = item.fanart;
      const mode = fa && fa.kind === 'disc' ? 'disc' : 'cover';
      const url =
        fa && (fa.kind === 'disc' || fa.kind === 'thumb') ? fa.url : item.poster_url;
      return { mode, url };
    }

    function setMessage(msg) {
      renderToken++; // cancel any in-flight image application
      burst = null;
      cd.style.filter = '';
      cd.classList.remove('has-full', 'cover-full');
      cdArtA.style.backgroundImage = '';
      cdArtB.style.backgroundImage = '';
      cdArtA.style.opacity = '1';
      cdArtB.style.opacity = '0';
      currentLayer = cdArtA;
      cdLabel.style.backgroundImage = '';
      titleEl.textContent = msg;
      subEl.textContent = '';
    }

    function setMeta(item) {
      titleEl.textContent = item.title || t('home.shelf.untitled');
      subEl.innerHTML = '';
      if (item.year) subEl.append(document.createTextNode(String(item.year)));
      if (item.rating) {
        if (item.year) subEl.append(document.createTextNode('   '));
        const stars = el('span', { class: 'cd-stars' });
        stars.innerHTML =
          `<span style="color:var(--stars)">${'★'.repeat(item.rating)}</span>` +
          `<span style="color:var(--text-secondary)">${'☆'.repeat(5 - item.rating)}</span>`;
        subEl.append(stars);
      }
    }

    // `immediate` skips the spin-burst — used by the type switch, which does its
    // own fade and must not also spin.
    function renderPick(item, immediate = false) {
      if (!item) return;
      const token = ++renderToken;
      const { mode, url } = artOf(item);

      const showing =
        cd.classList.contains('has-full') || cd.classList.contains('cover-full');

      // First pick, reduced motion, or a type switch (where the card is already
      // hidden behind the fade): show it outright, no spin-up / crossfade.
      if (!showing || reduceMotion || immediate) {
        burst = null;
        cd.style.filter = '';
        setMeta(item);
        setChrome(mode);
        setLayerImage(currentLayer, url, token);
        currentLayer.style.opacity = '1';
        otherLayer().style.opacity = '0';
        return;
      }

      // Shuffle: paint the new art onto the other layer at opacity 0; the frame
      // loop spins the disc up, blurs, and crossfades it in over the old art.
      // The metadata rides along on `burst.item` and is applied at the peak, so
      // the text and the artwork change in the same instant.
      const inc = otherLayer();
      inc.style.zIndex = '2';
      currentLayer.style.zIndex = '1';
      inc.style.opacity = '0';
      setLayerImage(inc, url, token);
      burst = { start: null, mode, inc, token, item, committed: false };
    }
    function emptyMessage() {
      return state.type === 'movie' ? t('home.shelf.emptyMovies') : t('home.shelf.emptyShows');
    }

    // Instant shuffle: dequeue an already-loaded title (rare drained case waits
    // on a single fetch); the queue tops itself back up in the background.
    //
    // Guarded: a second tap while a burst is still running used to start a fresh
    // burst over the top of it, snapping the half-faded incoming layer back to 0
    // and leaving both layers briefly visible at once. One shuffle at a time.
    let shuffling = false;
    async function doShuffle() {
      if (shuffling || switching) return;
      shuffling = true;
      try {
        const item = await queue().next();
        if (item) renderPick(item);
        else setMessage(emptyMessage());
      } finally {
        // Release once the burst has played out, so taps can't stack up.
        setTimeout(() => {
          shuffling = false;
        }, RD_BURST_MS);
      }
    }

    // Fade the card + metadata out, swap in the other type's (already warm)
    // pick, then fade back in. Distinct from the shuffle on purpose: nothing
    // spins, the whole card leaves and a different one arrives.
    let switching = false;
    async function switchType() {
      if (switching) return;
      switching = true;
      switchWrap.classList.add('rd-leaving');
      meta.classList.add('rd-leaving');
      // Resolve the new pick WHILE the card is fading out, so the wait (if any)
      // is hidden behind the fade rather than shown as a loading state.
      const [res] = await Promise.all([
        queue().ensureLoaded(state.type),
        new Promise((r) => setTimeout(r, RD_SWITCH_MS)),
      ]);
      // Content swaps while the card is invisible — never mid-transition.
      if (res.failed) setMessage(t('home.shelf.loadError'));
      else if (res.empty) setMessage(emptyMessage());
      else renderPick(res.first, true);
      switchWrap.classList.remove('rd-leaving');
      meta.classList.remove('rd-leaving');
      setTimeout(() => {
        switching = false;
      }, RD_SWITCH_MS);
    }

    // First load only. ensureLoaded reuses the background-warmed queue when it's
    // ready (instant, no flash) and otherwise loads on the spot, showing the
    // message below as a fallback.
    async function initType() {
      setMessage(t('home.shelf.loading'));
      const res = await queue().ensureLoaded(state.type);
      if (res.failed) return setMessage(t('home.shelf.loadError'));
      if (res.empty) return setMessage(emptyMessage());
      renderPick(res.first);
    }

    setMessage(t('home.shelf.loading'));

    modal.append(
      el('h3', { text: t('home.backToShelf') }),
      toggle,
      switchWrap,
      meta,
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.close') }),
    ]),
        shuffleBtn,
      ])
    );

    startSpin(); // begins once the modal is in the DOM (rAF fires post-append)
    initType();
  }, { handle: true });
}
