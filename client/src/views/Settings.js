// Settings screen (/settings) — a tabbed page grouping cache management, API
// usage budgets, library XML backup/restore, TV Time import, appearance, install
// (Add to Home Screen), notifications, list management, Kodi, and account. Tabs
// are built from what actually exists; Account appears only when auth is on.

import { api, createApi, isAbortError } from '../api.js';
import { onCleanup } from '../router.js';
import { currentTheme, setTheme } from '../theme.js';
import { getPref, setPref } from '../prefs.js';
import { pushSupported, enablePush, disablePush, currentPushEndpoint } from '../push.js';
import { signOut } from '../signOut.js';
import { buildKodiSettings } from './kodiSettings.js';
import { buildMagicLinks } from './magicLinks.js';
import { buildHousehold } from './household.js';
import { buildDevices } from './devices.js';
import { canInstall, isIOS, openAddToHome } from '../addToHome.js';
import {
  el,
  icons,
  clear,
  skelLine,
  toast,
  openModal,
  formatBytes,
  formatDate,
  segmentedBar,
  segmentedControl,
  settingsRow,
  settingsHeader,
  settingsRule,
  iconAction,
  confirmModal,
  lucideIcon,
  selectPill,
} from '../ui.js';
import { t, getLang, setLang, LANGUAGES, locale } from '../i18n.js';

export default async function Settings(container) {
  let pollTimer = null;
  let filesData = null; // filled when importFiles resolves

  const ac = new AbortController();
  const api = createApi(ac.signal);
  // On navigate-away: stop polling and abort any in-flight requests.
  onCleanup(() => {
    if (pollTimer) clearInterval(pollTimer);
    ac.abort();
  });

  // Who is signed in decides what this page offers: running the instance
  // (household, Kodi, cache, API budgets, metadata language, TV Time import) is
  // the master's; everyone gets their own preferences, lists, backup and account.
  // The server enforces the same split, so this only keeps members from seeing
  // controls that would answer "forbidden". No login configured = the owner.
  const authP = api.authStatus().catch(() => null);
  const isMaster = (s) => !s || !s.enabled || !s.user || s.user.role === 'master';

  const header = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' } }, [
    el('button', { class: 'icon-btn', html: icons.back, 'aria-label': t('common.back'), onClick: () => history.back() }),
    el('h2', { style: { margin: 0, fontSize: '20px' }, text: t('common.settings') }),
  ]);

  // --- Cache Management (ON-DEMAND — nothing scans the cache automatically) ---
  const cacheSection = el('div', { class: 'settings-section' });
  const cacheResults = el('div', { class: 'cache-results muted' });
  cacheResults.style.display = 'none'; // nothing to show until a check has run

  // The destructive clear stays hidden until a check has run this session, so
  // the user always sees what they are about to delete first.
  const cacheClearRow = settingsRow({
    icon: 'trash-2',
    label: t('settings.cache.clearAll'),
    sub: t('settings.cache.clearAllSub'),
    danger: true,
    onClick: () =>
      confirmModal({
        title: t('settings.cache.clearTitle'),
        body: t('settings.cache.clearBody'),
        confirmLabel: t('settings.cache.clearConfirm'),
        onConfirm: async () => {
          try {
            await api.clearAllCache();
            toast(t('settings.cache.cleared'), 'ok');
            checkCache();
          } catch (err) {
            toast(err.message, 'bad');
            throw err; // keep the dialog open
          }
        },
      }),
  });
  const cacheClearRule = settingsRule();
  cacheClearRow.el.style.display = 'none';
  cacheClearRule.style.display = 'none';

  const cacheRefreshRow = settingsRow({
    icon: 'refresh-cw',
    label: t('settings.cache.refreshOngoing'),
    sub: t('settings.cache.refreshOngoingSub'),
    onClick: async ({ report }) => {
      try {
        const res = await api.refreshOngoing();
        report(`${res.refreshed}/${res.total}`);
      } catch (err) {
        toast(err.message, 'bad');
      }
    },
  });

  const cacheCheckRow = settingsRow({
    icon: 'hard-drive',
    label: t('settings.cache.check'),
    sub: t('settings.cache.checkSub'),
    onClick: () => checkCache(),
  });
  async function checkCache() {
    cacheCheckRow.busy(true);
    try {
      const data = await api.cacheStats();
      renderCacheResults(cacheResults, data);
      cacheResults.style.display = '';
      cacheCheckRow.report(formatBytes(data.total_bytes || 0), 0);
      // Reveal the destructive row now the size is on screen.
      cacheClearRow.el.style.display = '';
      cacheClearRule.style.display = '';
    } catch (err) {
      cacheResults.style.display = '';
      cacheResults.textContent = err.message || t('settings.cache.readError');
      cacheCheckRow.report('');
    } finally {
      cacheCheckRow.busy(false);
    }
  }

  function renderCacheResults(wrap, data) {
    wrap.className = 'cache-results';
    wrap.innerHTML = '';
    const row = (label, value, cls) =>
      el('div', { class: 'settings-row' + (cls ? ' ' + cls : '') }, [
        el('span', { text: label }),
        el('span', { class: 'muted', text: value }),
      ]);
    wrap.append(row(t('settings.cache.totalSize'), t('settings.cache.totalValue', { size: formatBytes(data.total_bytes || 0), n: data.total_files || 0 })));
    if ((data.folders || []).length) {
      data.folders.forEach((f) =>
        wrap.append(row(f.name, t('settings.cache.folderValue', { size: formatBytes(f.bytes), n: f.files }), 'cache-sub'))
      );
    } else {
      wrap.append(el('div', { class: 'muted', text: t('settings.cache.empty') }));
    }
    wrap.append(row(t('settings.cache.oldest'), data.oldest_cached_at ? formatDate(data.oldest_cached_at) : '–'));
  }

  cacheSection.append(
    settingsHeader('hard-drive', t('settings.cache.title')),
    cacheCheckRow.el,
    cacheResults,
    cacheRefreshRow.el,
    cacheClearRule,
    cacheClearRow.el
  );

  // --- API Usage (self-imposed monthly budgets) ---
  const usageSection = el('div', { class: 'settings-section' });
  const fmtNum = (n) => Number(n || 0).toLocaleString(locale('en-US'));

  // "2026-08" → "Aug 2026".
  function fmtMonth(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    if (!m) return ym || '';
    return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(locale('en-US'), {
      month: 'short',
      year: 'numeric',
    });
  }

  // Glyph per service. The brand tint rides on the glyph only — status owns the
  // meter colour, so a colour can never mean "this is TMDB" and "this is fine"
  // at the same time.
  const USAGE_GLYPH = { tmdb: 'clapperboard', fanart: 'image' };
  const CAP_PRESETS = [
    [t('settings.usage.unlimited'), 0],
    ['500', 500],
    [fmtNum(1000), 1000],
    [fmtNum(5000), 5000],
  ];

  async function applyCap(apiName, value) {
    try {
      const d = await api.setUsageCap(apiName, value);
      renderUsage(d.usage);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  // One card per API: the count large, a watermark glyph bleeding off the
  // corner, and a share bar ONLY when a budget exists. With no cap there is no
  // proportion to draw, so nothing is drawn.
  function buildUsageCard(u) {
    const limited = u.cap > 0;
    const pct = limited ? Math.min(100, Math.round((u.used / u.cap) * 100)) : 0;
    const crit = limited && !u.bypassed && u.used >= u.cap;
    const warn = limited && !crit && pct >= 80;

    let meter = 'color-mix(in srgb, var(--text-secondary) 60%, transparent)';
    if (crit) meter = 'var(--danger)';
    else if (warn || u.bypassed) meter = 'var(--accent)';

    let status = t('settings.usage.noBudget');
    if (u.bypassed) status = t('settings.usage.budgetIgnored');
    else if (crit) status = t('settings.usage.overBudget');
    else if (limited) status = t('settings.usage.pctOf', { pct, cap: fmtNum(u.cap) });

    const glyph = USAGE_GLYPH[u.api] || 'circle-check';
    const card = el('div', { class: 'usage-card' }, [
      lucideIcon(glyph, 'usage-wm'),
      el('div', { class: 'usage-head' }, [
        lucideIcon(glyph, 'usage-glyph'),
        el('span', { class: 'usage-name', text: u.label }),
      ]),
      el('div', { class: 'usage-value', text: fmtNum(u.used) }),
      el('div', { class: 'usage-line', text: t('settings.usage.callsIn', { month: fmtMonth(u.month), status }) }),
    ]);
    card.style.setProperty('--usage-ink', u.accent);
    card.style.setProperty('--usage-meter', meter);
    if (limited) {
      card.append(el('div', { class: 'usage-bar' }, [el('i', { style: { width: `${pct}%` } })]));
    }

    // Budget editor: presets cover the useful range, the field handles the rest.
    const capInput = el('input', {
      class: 'text-field usage-custom',
      type: 'number',
      min: '0',
      step: '100',
      placeholder: t('settings.usage.customLimit'),
    });
    if (limited && !CAP_PRESETS.some(([, v]) => v === u.cap)) capInput.value = String(u.cap);
    capInput.addEventListener('change', () =>
      applyCap(u.api, Math.max(0, parseInt(capInput.value, 10) || 0))
    );

    const presets = el('div', { class: 'usage-presets' });
    for (const [label, value] of CAP_PRESETS) {
      const on = value === 0 ? !limited : u.cap === value;
      presets.append(
        el('button', {
          class: 'usage-preset' + (on ? ' active' : ''),
          type: 'button',
          text: label,
          onClick: () => applyCap(u.api, value),
        })
      );
    }

    // The bypass is a boolean, so it wears the app's boolean control instead of
    // a shrunken .btn — and it says what it does. Meaningless with no budget.
    const bypassRow = settingsRow({
      icon: 'shield',
      label: t('settings.usage.ignore'),
      sub: t('settings.usage.ignoreSub'),
      control: 'switch',
      checked: !!u.bypassed,
      onChange: async (on) => {
        try {
          const d = await api.usageBypass(u.api, on);
          toast(on ? t('settings.usage.ignoredToast') : t('settings.usage.enforcedToast'), 'ok');
          renderUsage(d.usage);
        } catch (err) {
          toast(err.message, 'bad');
          renderUsage(null);
        }
      },
    });
    if (!limited) bypassRow.setDisabled(true);

    card.append(
      el('div', { class: 'usage-budget' }, [
        el('div', { class: 'usage-budget-label', text: t('settings.usage.monthlyBudget') }),
        presets,
        capInput,
        bypassRow.el,
      ])
    );
    return card;
  }

  function renderUsage(list) {
    clear(usageSection);
    usageSection.append(
      settingsHeader('trending-up', t('settings.usage.title')),
      el('div', {
        class: 'muted usage-desc',
        text: t('settings.usage.desc'),
      })
    );
    if (list === null) {
      usageSection.append(el('div', { class: 'settings-row' }, [skelLine({ width: '60%' })]));
      return;
    }
    const cards = el('div', { class: 'usage-cards' });
    for (const u of list) cards.append(buildUsageCard(u));
    usageSection.append(cards);
  }
  renderUsage(null); // ghost frame

  // --- Backup: export / import the whole library as an XML file ---
  const backupSection = el('div', { class: 'settings-section' });
  {
    const exportRow = settingsRow({
      icon: 'file-down',
      label: t('settings.backup.export'),
      sub: t('settings.backup.exportSub'),
      onClick: async ({ report }) => {
      try {
        const { blob, filename } = await api.exportLibrary();
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: filename });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        report(t('settings.backup.saved'));
      } catch (err) {
        toast(err.message || t('settings.backup.exportFailed'), 'bad');
      }
      },
    });

    // Hidden file picker for import.
    const fileInput = el('input', {
      type: 'file',
      accept: '.xml,application/xml,text/xml',
      style: { display: 'none' },
    });
    const importRow = settingsRow({
      icon: 'file-up',
      label: t('settings.backup.import'),
      sub: t('settings.backup.importSub'),
      onClick: () => fileInput.click(),
    });

    const importStatusLine = el('div', { class: 'muted backup-status' });
    importStatusLine.style.display = 'none';
    const importSummary = el('div', { class: 'backup-summary' });
    importSummary.style.display = 'none';

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ''; // allow re-selecting the same file later
      if (!file) return;
      importSummary.style.display = 'none';
      importSummary.innerHTML = '';
      importStatusLine.style.display = '';
      importStatusLine.textContent = t('settings.backup.reading');
      importRow.busy(true);
      exportRow.setDisabled(true);
      try {
        const xml = await file.text();
        const res = await api.importLibrary(xml);
        importStatusLine.style.display = 'none';
        renderImportSummary(importSummary, res);
        importSummary.style.display = '';
      } catch (err) {
        importStatusLine.style.display = 'none';
        importSummary.style.display = '';
        importSummary.innerHTML = '';
        importSummary.append(
          el('div', { class: 'backup-error', text: err.message || t('settings.backup.importFailed') })
        );
      } finally {
        importRow.busy(false);
        exportRow.setDisabled(false);
      }
    });

    backupSection.append(
      settingsHeader('library-big', t('settings.backup.title')),
      el('div', {
        class: 'muted usage-desc',
        text: t('settings.backup.desc'),
      }),
      exportRow.el,
      importRow.el,
      fileInput,
      importStatusLine,
      importSummary
    );
  }

  // --- TV Time Import (ON-DEMAND — files are scanned only when requested) ---
  const importSection = el('div', { class: 'settings-section' });
  const importResults = el('div', { class: 'import-results muted' });
  importResults.style.display = 'none'; // nothing to show until a check has run

  const checkFilesRow = settingsRow({
    icon: 'folder-search',
    label: t('settings.tvtime.check'),
    sub: t('settings.tvtime.checkSub'),
    onClick: () => checkImportFiles(),
  });
  async function checkImportFiles() {
    checkFilesRow.busy(true);
    importResults.className = 'import-results';
    try {
      filesData = await api.importFiles();
      renderImportFiles(importResults, filesData);
      importResults.style.display = '';
      const ok = !!(filesData.actions && filesData.actions.valid);
      startRow.setDisabled(!ok);
      checkFilesRow.report(ok ? t('settings.tvtime.ready') : t('settings.tvtime.noFiles'), 0);
    } catch (err) {
      importResults.className = 'import-results muted';
      importResults.style.display = '';
      importResults.textContent = err.message || t('settings.tvtime.readError');
      startRow.setDisabled(true);
      checkFilesRow.report('');
    } finally {
      checkFilesRow.busy(false);
    }
  }

  function fileLine(role, f, requiredLabel) {
    if (!f || !f.found) {
      return el('div', { class: 'import-file bad', text: t('settings.tvtime.fileNotFound', { role }) });
    }
    const size = formatBytes(f.size);
    if (f.valid) {
      return el('div', {
        class: 'import-file ok',
        text: t('settings.tvtime.fileOk', { name: f.name, rows: f.rows.toLocaleString(locale('en-US')), size, n: f.rows }),
      });
    }
    return el('div', {
      class: 'import-file warn',
      text: `⚠ ${f.name} (${size}): ${f.issue || t('settings.tvtime.appearsInvalid')}`,
    });
  }
  function renderImportFiles(wrap, files) {
    wrap.className = 'import-results';
    wrap.innerHTML = '';
    if (!files.actions.found && !files.episodes.found) {
      wrap.append(el('div', { class: 'muted', text: t('settings.tvtime.folderEmpty') }));
      return;
    }
    wrap.append(fileLine(t('settings.tvtime.roleActions'), files.actions));
    if (files.episodes.found) {
      wrap.append(fileLine(t('settings.tvtime.roleEpisodes'), files.episodes));
    } else {
      wrap.append(el('div', {
        class: 'import-file warn',
        text: t('settings.tvtime.episodesMissing'),
      }));
    }
  }

  const progressWrap = el('div', { class: 'import-progress' });
  const bar = el('div', { class: 'bar-progress' }, [el('div', { style: { width: '0%' } })]);
  const progressText = el('div', { class: 'muted' });
  const summaryText = el('div', { class: 'import-summary' });

  const startRow = settingsRow({
    icon: 'play-circle',
    label: t('settings.tvtime.start'),
    sub: t('settings.tvtime.startSub'),
    onClick: () => startImport(),
  });
  startRow.setDisabled(true); // until a check confirms a valid actions file
  const logRow = settingsRow({
    icon: 'signpost',
    label: t('settings.tvtime.notFound'),
    sub: t('settings.tvtime.notFoundSub'),
    control: 'chevron',
    onClick: () => showLog(),
  });

  importSection.append(
    settingsHeader('refresh-cw', t('settings.tvtime.title')),
    el('div', {
      class: 'muted usage-desc',
      text: t('settings.tvtime.desc'),
    }),
    checkFilesRow.el,
    importResults,
    startRow.el,
    progressWrap
  );
  progressWrap.append(bar, progressText, summaryText, logRow.el);
  logRow.el.style.display = 'none';
  bar.style.display = 'none';

  function renderStatus(s) {
    const running = s.running;
    startRow.setDisabled(running || !(filesData && filesData.actions && filesData.actions.valid));
    const pct = s.total ? Math.round((s.processed / s.total) * 100) : 0;
    bar.firstChild.style.width = `${pct}%`;
    // Only show the progress bar once an import is running or has run.
    bar.style.display = running || s.finished || s.processed > 0 ? 'block' : 'none';
    if (running) {
      progressText.textContent = t('settings.tvtime.importing', { title: s.current_title || '…', processed: s.processed, total: s.total });
      summaryText.textContent = '';
      logRow.el.style.display = 'none';
    } else if (s.finished || s.processed > 0) {
      progressText.textContent = '';
      summaryText.textContent = t('settings.tvtime.summary', { shows: s.imported_shows, movies: s.imported_movies, skipped: s.skipped, notFound: s.not_found });
      logRow.el.style.display = s.not_found > 0 ? '' : 'none';
    } else {
      progressText.textContent = '';
      summaryText.textContent = '';
    }
  }

  // --- Appearance (theme + client UI toggles) ---
  const appearanceSection = el('div', { class: 'settings-section' }, [
    settingsHeader('palette', t('settings.appearance')),
  ]);
  // A dropdown, not a segmented control: the list of languages can grow without
  // the row growing with it (the OS picker scrolls and type-ahead finds a name).
  const lang = selectPill({
    options: LANGUAGES.map((l) => ({ value: l.code, text: l.name })),
    value: getLang(),
    className: 'selpill--block',
    onChange: (v) => setLang(v),
  });
  lang.select.setAttribute('aria-label', t('settings.language')); // the row label is visible above
  const langRow = el('div', { class: 'srow srow--stack' }, [
    el('div', { class: 'srow-head' }, [
      lucideIcon('languages', 'srow-ico'),
      el('div', { class: 'srow-label', text: t('settings.language') }),
    ]),
    lang.el,
  ]);

  // Three-way theme picker (System / Dark / Light) as a segmented control rather
  // than a single dark-mode switch: "System" follows the OS, and applies live.
  const theme = segmentedControl({
    options: [
      ['system', t('settings.theme.system'), 'sun-moon'],
      ['dark', t('settings.theme.dark'), 'moon'],
      ['light', t('settings.theme.light'), 'sun'],
    ],
    value: currentTheme(),
    ariaLabel: t('settings.theme.label'),
    onChange: (v) => setTheme(v), // applies instantly, no reload
  });
  const themeRow = el('div', { class: 'srow srow--stack' }, [
    el('div', { class: 'srow-head' }, [
      lucideIcon('sun-moon', 'srow-ico'),
      el('div', { class: 'srow-label', text: t('settings.theme.label') }),
    ]),
    theme.el,
  ]);

  // A client-preference toggle row (localStorage-backed booleans).
  function prefToggleRow(icon, labelText, sub, prefKey) {
    return settingsRow({
      icon,
      label: labelText,
      sub,
      control: 'switch',
      checked: getPref(prefKey),
      onChange: (on) => setPref(prefKey, on),
    }).el;
  }

  appearanceSection.append(
    langRow,
    themeRow,
    prefToggleRow('snowflake', t('settings.snow'), t('settings.snowSub'), 'snow'),
    prefToggleRow('vibrate', t('settings.haptic'), t('settings.hapticSub'), 'haptic')
  );

  // --- Install (Add to Home Screen) — only when it's actually installable ---
  // iOS can't be triggered programmatically, so on iOS the button opens the
  // Share-sheet instructions; on Android it fires the native install dialog.
  const installSection = el('div', { class: 'settings-section' });
  if (canInstall()) {
    installSection.append(
      settingsHeader('smartphone', t('settings.install.title')),
      settingsRow({
        icon: 'download',
        label: t('settings.install.addToHome'),
        sub: isIOS()
          ? t('settings.install.subIOS')
          : t('settings.install.sub'),
        control: 'chevron',
        onClick: () => openAddToHome(),
      }).el
    );
  } else {
    installSection.style.display = 'none';
  }

  // --- Notifications (push) ---
  const notificationsSection = el('div', { class: 'settings-section' }, [
    settingsHeader('bell', t('settings.notif.title')),
  ]);
  buildNotificationsSection(notificationsSection);

  // Push toggle: subscribe/unsubscribe via the browser + backend. Absent (with a
  // note) on devices without Web Push. Reflects the server subscription state.
  function buildNotificationsSection(section) {
    if (!pushSupported()) {
      // Still a row, so the setting reads as present-but-unavailable rather
      // than as a stray sentence.
      const dead = settingsRow({
        icon: 'tv',
        label: t('settings.notif.newEpisodes'),
        sub: t('settings.notif.unsupported'),
        control: 'switch',
      });
      dead.setDisabled(true);
      section.append(dead.el);
      return;
    }

    const testRow = settingsRow({
      icon: 'send',
      label: t('settings.notif.test'),
      sub: t('settings.notif.testSub'),
      onClick: async ({ report }) => {
        try {
          const res = await api.pushTest();
          const sent = !!(res && res.ok);
          if (sent) report(t('settings.notif.sent'));
          else toast(t('settings.notif.testFailed'), 'bad');
        } catch {
          toast(t('settings.notif.testFailed'), 'bad');
        }
      },
    });
    testRow.el.style.display = 'none';

    const notifRow = settingsRow({
      icon: 'tv',
      label: t('settings.notif.newEpisodes'),
      sub: t('settings.notif.newEpisodesSub'),
      control: 'switch',
      onChange: async (wantOn) => {
        const input = notifRow.el.querySelector('input');
        input.disabled = true;
        try {
          if (wantOn) {
            await enablePush();
            setPref('push', true);
            toast(t('settings.notif.enabled'), 'ok');
            testRow.el.style.display = '';
          } else {
            await disablePush();
            setPref('push', false);
            toast(t('settings.notif.disabled'), 'ok');
            testRow.el.style.display = 'none';
          }
        } catch (err) {
          notifRow.setChecked(!wantOn); // revert the switch on failure
          toast(err.message || t('settings.notif.updateFailed'), 'bad');
        } finally {
          input.disabled = false;
        }
      },
    });
    section.append(notifRow.el, testRow.el);

    // Reflect whether THIS device notifies the signed-in member (another
    // member may have enabled notifications on it before).
    currentPushEndpoint()
      .then((endpoint) => (endpoint ? api.pushConfig(endpoint) : { subscribed: false }))
      .then((cfg) => {
        const on = !!(cfg && cfg.subscribed);
        notifRow.setChecked(on);
        setPref('push', on);
        testRow.el.style.display = on ? '' : 'none';
      })
      .catch(() => {});
  }

  // --- Account (log out) — only shown when login is enabled ---
  const accountSection = el('div', { class: 'settings-section' });
  accountSection.style.display = 'none';
  // Magic Links and Devices live alongside the account section; only shown when
  // auth is on.
  const magicSection = buildMagicLinks(api);
  magicSection.style.display = 'none';
  const devicesSection = el('div');
  authP
    .then((s) => {
      if (!s || !s.enabled) return; // auth disabled → nothing to log out of
      accountSection.style.display = '';
      magicSection.style.display = '';
      devicesSection.replaceWith(buildDevices(api));
      // Switch profile = sign out of this device and land on the picker. What
      // this device kept about the member goes with them (see signOut.js).
      const logoutRow = settingsRow({
        icon: 'log-out',
        label: t('settings.account.switch'),
        sub: t('settings.account.switchSub'),
        onClick: () => signOut(),
      });

      // Sign out ALL devices: invalidates every session everywhere (including
      // this one) by advancing the server's session generation, and stops this
      // member's notifications on every device. Irreversible
      // without logging back in, so it takes the single destructive treatment
      // and the app's own confirm rather than the browser's.
      const logoutAllRow = settingsRow({
        icon: 'users',
        label: t('settings.account.logoutAll'),
        sub: t('settings.account.logoutAllSub'),
        danger: true,
        onClick: () =>
          confirmModal({
            title: t('settings.account.logoutAllTitle'),
            body: t('settings.account.logoutAllBody'),
            confirmLabel: t('settings.account.logoutAllConfirm'),
            onConfirm: () => signOut({ everywhere: true }),
          }),
      });

      accountSection.append(settingsHeader('shield', t('settings.account.title')), logoutRow.el);
      // The access log covers every account, so it is the master's to read.
      if (isMaster(s)) buildAccessLog(accountSection);
      accountSection.append(settingsRule(), logoutAllRow.el);
      // Reveal the Account tab chip only when there's actually an account to
      // manage (never an empty tab). chipByKey is populated below, before this
      // async callback can run.
      if (chipByKey.account) {
        chipByKey.account.style.display = '';
        tabBar.refresh(); // the track just got wider — re-measure the chip
      }
    })
    .catch(() => {});

  // Read-only "Recent access" panel appended under the Account section: the last
  // authentication events so the owner can spot unfamiliar activity at a glance.
  // The server stores only hashed identifiers, so nothing here reveals an IP.
  function buildAccessLog(section) {
    const EVENT_LABELS = {
      login: t('settings.access.login'),
      magic_link: t('settings.access.magicLink'),
      logout_all: t('settings.access.logoutAll'),
      invite: t('settings.access.invite'),
    };
    // A chevron row: it expands rather than acting, so the Account group stays
    // tidy until you ask for the history.
    const body = el('div', { class: 'srow-body', style: { display: 'none' } });
    let open = false;
    const accessRow = settingsRow({
      icon: 'clock',
      label: t('settings.access.title'),
      sub: t('settings.access.sub'),
      control: 'chevron',
      onClick: () => {
        open = !open;
        body.style.display = open ? '' : 'none';
        accessRow.setOpen(open);
      },
    });

    body.append(
      el('div', {
        class: 'muted',
        style: { marginBottom: '8px', fontSize: '12.5px' },
        text: t('settings.access.hashNote'),
      })
    );
    const list = el('div', { class: 'stack' });
    list.append(el('div', { class: 'muted', text: t('settings.access.loading') }));
    body.append(list);

    section.append(accessRow.el, body);

    api
      .accessLog()
      .then((d) => {
        // Show only the 5 most recent attempts (server returns newest-first).
        const entries = ((d && d.entries) || []).slice(0, 5);
        list.innerHTML = '';
        if (!entries.length) {
          list.append(el('div', { class: 'muted', text: t('settings.access.empty') }));
          return;
        }
        for (const e of entries) {
          let when = '';
          try {
            when = new Date(e.created_at).toLocaleString(locale());
          } catch {
            when = '';
          }
          list.append(
            el('div', { class: 'settings-row' }, [
              el('div', {}, [
                el('span', { text: (EVENT_LABELS[e.event] || e.event) + (e.user ? ` · ${e.user}` : '') }),
                el('span', { class: 'muted', style: { marginLeft: '8px', fontSize: '12px' }, text: when }),
              ]),
              el('span', {
                style: { fontSize: '12px', color: e.success ? 'var(--text-secondary)' : 'var(--danger)' },
                text: e.success ? t('settings.access.success') : t('settings.access.failed'),
              }),
            ])
          );
        }
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        list.innerHTML = '';
        list.append(el('div', { class: 'muted', text: t('settings.access.loadError') }));
      });
  }

  // --- Lists management ---
  const listsSection = el('div', { class: 'settings-section' });
  function renameListModal(list) {
    openModal((modal, close) => {
      const input = el('input', { class: 'text-field', type: 'text', value: list.name });
      const save = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('check', 'btn-lucide'),
      el('span', { text: t('common.save') }),
    ]);
      save.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        save.disabled = true;
        try {
          await api.renameList(list.id, name);
          close();
          reloadLists();
        } catch (err) {
          save.disabled = false;
          toast(err.message || t('settings.failed'), 'bad');
        }
      });
      modal.append(
        el('h3', { text: t('settings.lists.renameTitle') }),
        input,
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
          save,
        ])
      );
    });
  }
  function removeList(list) {
    confirmModal({
      title: t('settings.lists.deleteTitle', { name: list.name }),
      body: t('settings.lists.deleteBody'),
      confirmLabel: t('settings.lists.deleteConfirm'),
      onConfirm: async () => {
        try {
          await api.deleteList(list.id);
          toast(t('settings.lists.deleted'), 'ok');
          reloadLists();
        } catch (err) {
          toast(err.message || t('settings.failed'), 'bad');
          throw err;
        }
      },
    });
  }
  function newListForm() {
    const nameInput = el('input', { class: 'text-field', type: 'text', placeholder: t('settings.lists.namePlaceholder') });
    let type = 'movie';
    // Shared segmented control, centred in the form (the app default for this
    // kind of choice).
    const typeSeg = segmentedControl({
      options: [
        ['movie', t('media.movies')],
        ['show', t('media.tvShows')],
      ],
      value: type,
      ariaLabel: t('settings.lists.type'),
      center: true,
      onChange: (v) => {
        type = v;
      },
    });
    const typeRow = typeSeg.el;
    const createBtn = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('plus', 'btn-lucide'),
      el('span', { text: t('settings.lists.create') }),
    ]);
    createBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) {
        toast(t('settings.lists.enterName'));
        return;
      }
      createBtn.disabled = true;
      try {
        await api.createList(name, type);
        nameInput.value = '';
        toast(t('settings.lists.created'), 'ok');
        reloadLists();
      } catch (err) {
        toast(err.message || t('settings.failed'), 'bad');
      } finally {
        createBtn.disabled = false;
      }
    });
    return el('div', { class: 'new-list-form' }, [
      el('div', { class: 'field-label', text: t('settings.lists.newList') }),
      nameInput,
      typeRow,
      el('div', { class: 'stack', style: { marginTop: '8px' } }, [createBtn]),
    ]);
  }
  function renderLists(lists) {
    clear(listsSection);
    listsSection.append(settingsHeader('list-plus', t('settings.lists.title')));
    if (lists === null) {
      listsSection.append(el('div', { class: 'settings-row' }, [skelLine({ width: '70%' })]));
      return;
    }
    if (!lists.length) {
      listsSection.append(
        el('div', { class: 'muted usage-desc', text: t('settings.lists.empty') })
      );
    }
    for (const l of lists) {
      listsSection.append(
        settingsRow({
          icon: l.type === 'movie' ? 'clapperboard' : 'tv',
          label: l.name,
          sub: t('settings.lists.sub', { type: l.type === 'movie' ? t('media.movies') : t('media.series'), n: l.count }),
          end: [
            iconAction({ icon: 'square-pen', label: t('settings.lists.rename'), onClick: () => renameListModal(l) }),
            iconAction({ icon: 'trash-2', label: t('common.delete'), danger: true, onClick: () => removeList(l) }),
          ],
        }).el
      );
    }
    listsSection.append(newListForm());
  }
  function reloadLists() {
    api
      .lists()
      .then((d) => renderLists(d.lists || []))
      .catch((err) => {
        if (isAbortError(err)) return;
        renderLists([]);
      });
  }
  renderLists(null); // ghost frame

  // --- Kodi integration (self-contained section) ---
  // --- Metadata language (server-side: what shelfIt asks TMDB for) ---------
  // Distinct from the app language in General: that one translates the
  // interface, this one decides the language of the titles, plots and episode
  // names TMDB returns. Changing it re-downloads the library's metadata, so the
  // row locks itself while that runs and reloads afterwards — the grids keep a
  // per-session cache of the old titles.
  const metadataSection = el('div', { class: 'settings-section' }, [
    settingsHeader('languages', t('settings.metaLang')),
  ]);
  {
    const status = el('div', { class: 'muted backup-status' });
    status.style.display = 'none';

    const picker = selectPill({
      options: [
        { value: 'en-US', text: t('settings.metaLang.en') },
        { value: 'it-IT', text: t('settings.metaLang.it') },
      ],
      value: 'en-US',
      className: 'selpill--block',
      onChange: async (value) => {
        picker.select.disabled = true;
        status.style.display = '';
        status.textContent = t('settings.metaLangBusy');
        try {
          const res = await api.setMetadataLanguage(value);
          if (res && res.changed) {
            status.textContent = t('settings.metaLangDone', { count: res.refreshed || 0 });
            toast(t('settings.metaLangDone', { count: res.refreshed || 0 }), 'good');
            // Titles live in the grids' session cache and in every open view —
            // a reload is the only way to show them all in the new language.
            setTimeout(() => location.reload(), 900);
            return;
          }
          status.style.display = 'none';
        } catch (err) {
          if (isAbortError(err)) return;
          status.textContent = t('settings.metaLangFailed');
          toast(err.message || t('settings.metaLangFailed'), 'bad');
        } finally {
          picker.select.disabled = false;
        }
      },
    });
    picker.select.setAttribute('aria-label', t('settings.metaLang'));

    metadataSection.append(
      el('div', { class: 'srow srow--stack' }, [
        el('div', { class: 'srow-head' }, [
          lucideIcon('languages', 'srow-ico'),
          el('div', { class: 'srow-label', text: t('settings.metaLang') }),
        ]),
        picker.el,
        el('div', { class: 'srow-sub', text: t('settings.metaLangSub') }),
      ]),
      status
    );

    // Fill in the stored choice once the server answers; a failure leaves the
    // default showing rather than blocking the rest of the page.
    api
      .metadataLanguage()
      .then((res) => {
        if (res && res.language) picker.set(res.language);
      })
      .catch(() => { /* offline / error — keep the default */ });
  }

  const kodiSection = buildKodiSettings(api);

  // Filled with the Household section once the master is confirmed.
  const householdSection = el('div');

  // ------ Tabbed layout (chips) -----------------------------------------
  // The existing sections are re-parented into per-tab panels; nothing about how
  // each section works changes — only one panel is visible at a time. Tabs are
  // driven by what actually exists (no empty tabs; Account appears only when a
  // login is configured, the instance tabs only for the master).
  const wrapPanel = (...sections) => el('div', { class: 'settings-panel' }, sections);
  const TAB_DEFS = [
    { key: 'general', label: t('settings.tab.general'), panel: wrapPanel(appearanceSection, installSection, notificationsSection) },
    { key: 'library', label: t('settings.tab.library'), panel: wrapPanel(metadataSection, listsSection, backupSection, importSection) },
    { key: 'household', label: t('settings.tab.household'), panel: wrapPanel(householdSection), conditional: true },
    { key: 'kodi', label: 'Kodi', panel: wrapPanel(kodiSection), conditional: true },
    { key: 'advanced', label: t('settings.tab.advanced'), panel: wrapPanel(usageSection, cacheSection), conditional: true },
    // Account chip stays hidden until authStatus confirms a login is enabled.
    { key: 'account', label: t('settings.tab.account'), panel: wrapPanel(accountSection, devicesSection, magicSection), conditional: true },
  ];
  // The master's sections inside the shared Library tab, hidden until confirmed.
  metadataSection.style.display = 'none';
  importSection.style.display = 'none';

  // The tab strip uses the app's scrolling segmented track — same pattern as the
  // Movies/Series status filter, since this is likewise a single choice with more
  // options than fit across a phone. `chipByKey` still holds the real option
  // elements, so revealing the conditional Account tab is unchanged.
  const chipByKey = {};
  const tabBar = segmentedBar({
    options: TAB_DEFS.map((tab) => [tab.key, tab.label]),
    value: 'general',
    ariaLabel: t('settings.tabsAria'),
    onChange: (key) => selectTab(key),
  });
  const tabRow = tabBar.el;
  tabRow.classList.add('settings-tabs');
  function selectTab(key) {
    TAB_DEFS.forEach((tab) => {
      tab.panel.style.display = tab.key === key ? '' : 'none';
    });
    tabBar.set(key); // no-op when the track moved the chip itself
  }
  TAB_DEFS.forEach((tab) => {
    const chip = tabBar.optionEl(tab.key);
    if (tab.conditional) chip.style.display = 'none';
    chipByKey[tab.key] = chip;
  });

  // Render the result of a library import into `wrap`.
  function renderImportSummary(wrap, res) {
    wrap.innerHTML = '';
    const stat = (label, n) =>
      el('div', { class: 'backup-stat' }, [
        el('span', { class: 'backup-stat-num', text: String(n) }),
        el('span', { class: 'backup-stat-label', text: label }),
      ]);
    wrap.append(
      el('div', { class: 'backup-summary-head', text: t('settings.backup.complete') }),
      el('div', { class: 'backup-stats' }, [
        stat(t('settings.backup.added'), res.added || 0),
        stat(t('settings.backup.merged'), res.merged || 0),
        stat(t('settings.backup.unchanged'), res.unchanged || 0),
        stat(t('settings.backup.fetchesQueued'), res.fetches_queued || 0),
      ])
    );
    if (res.fetches_queued) {
      wrap.append(
        el('div', {
          class: 'muted backup-note',
          text: t('settings.backup.fetchingNote'),
        })
      );
    }
    const failures = res.failures || [];
    if (failures.length) {
      wrap.append(el('div', { class: 'backup-fail-head', text: t('settings.backup.failHead', { n: failures.length }) }));
      const list = el('ul', { class: 'backup-fail-list' });
      failures.slice(0, 30).forEach((f) =>
        list.append(el('li', { text: `${f.title}: ${f.reason}` }))
      );
      wrap.append(list);
    }
  }

  const panels = el('div', { class: 'settings-panels' }, TAB_DEFS.map((tab) => tab.panel));
  container.append(header, tabRow, panels);
  selectTab('general');

  reloadLists();

  // Cache size and TV Time import files are NEVER scanned automatically — the
  // user triggers each with its own button (see cacheSection / importSection).

  // The instance controls appear for the master only; for a member nothing of
  // them is fetched at all.
  authP.then((s) => {
    if (!isMaster(s)) return;
    metadataSection.style.display = '';
    importSection.style.display = '';
    for (const key of ['kodi', 'advanced']) chipByKey[key].style.display = '';
    if (s && s.enabled) {
      householdSection.replaceWith(buildHousehold(api));
      chipByKey.household.style.display = '';
    }
    tabBar.refresh(); // the track just got wider: re-measure the chips

    api
      .usage()
      .then((d) => renderUsage(d.usage || []))
      .catch((err) => {
        if (isAbortError(err)) return;
        renderUsage([]);
      });

    api
      .importStatus()
      .then((status) => {
        renderStatus(status);
        if (status.running) startPolling();
      })
      .catch(() => {});
  });

  async function startImport() {
    startRow.setDisabled(true);
    summaryText.textContent = '';
    try {
      await api.startImport();
    } catch (err) {
      if (err.status !== 409) {
        toast(err.message, 'bad');
        startRow.setDisabled(false);
        return;
      }
    }
    startPolling();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const s = await api.importStatus();
        renderStatus(s);
        if (!s.running) {
          clearInterval(pollTimer);
          pollTimer = null;
          // Cache is checked on demand only — do not auto-scan it after an import.
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  }

}

async function showLog() {
  let log = '';
  try {
    const res = await api.importLog();
    log = res.log || '';
  } catch {
    log = '';
  }
  openModal((modal, close) => {
    modal.append(
      el('h3', { text: t('settings.tvtime.notFound') }),
      el('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '13px', color: 'var(--text-secondary)', maxHeight: '50vh', overflow: 'auto' }, text: log || t('settings.tvtime.logNone') }),
      el('div', { class: 'modal-actions' }, [el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.close') }),
    ])])
    );
  });
}
