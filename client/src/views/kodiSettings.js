// Kodi settings section — multiple named instances, one active at a time, plus
// the master enable toggle. Built as a self-contained block appended into the
// Settings view. The config fields stay visible and editable even when the
// integration is disabled, so the user can set things up before switching it on.
//
// Each instance carries a selectable SVG icon (chosen from the files in
// icons/kodi/) shown on its card. Passwords are write-only from here: the form
// shows a blank password field, and leaving it blank on edit keeps the stored
// credential. The backend never sends a password back.

import { refreshKodi } from '../kodi.js';
import { openKodiReview } from '../kodiSync.js';
import { withBase } from '../basePath.js';
import {
  el,
  toast,
  openModal,
  skelLine,
  stateBlock,
  settingsHeader,
  confirmModal,
  iconAction,
  settingsRow,
  lucideIcon,
  selectPill,
} from '../ui.js';
import { t } from '../i18n.js';

// Fallback glyph for instances with no chosen icon.
const DEFAULT_ICON = '/icons/kodi.svg';

export function buildKodiSettings(api) {
  const section = el('div', { class: 'settings-section kodi-section' });

  const heading = settingsHeader('tv', 'Kodi');

  // Master enable toggle (top of the section).
  const enableRow = settingsRow({
    icon: 'tv',
    label: t('kodiSettings.enable'),
    sub: t('kodiSettings.enableSub'),
    control: 'switch',
    onChange: async (next) => {
      try {
        const cfg = await api.kodiSetEnabled(next);
        renderConfig(cfg);
        refreshKodi();
      } catch (err) {
        enableRow.setChecked(!next); // revert
        toast(err.message || t('kodiSettings.failed'), 'bad');
      }
    },
  });

  const listWrap = el('div', { class: 'kodi-list' }, [skelLine({ width: '80%' })]);

  const addRow = settingsRow({
    icon: 'server-plus',
    label: t('kodiSettings.addInstance'),
    sub: t('kodiSettings.addInstanceSub'),
    control: 'chevron',
    onClick: () => openInstanceForm(null),
  });

  // Manual "sync now" — runs the same sync as the daily scheduled one. It
  // reports in its own trailing slot; a concurrent (e.g. scheduled) run is
  // reported and ignored.
  const syncRow = settingsRow({
    icon: 'book-check',
    label: t('kodiSettings.sync'),
    sub: t('kodiSettings.syncSub'),
    onClick: async ({ report }) => {
    try {
      const res = await api.kodiSync();
      if (res && res.alreadyRunning) {
        toast(t('kodiSettings.syncRunning'));
      } else if (res && res.skipped === 'unreachable') {
        toast(t('kodiSettings.unreachableToast'), 'bad');
      } else if (res && res.skipped) {
        toast(t('kodiSettings.enableFirst'));
      } else if (res && res.discoveries && res.discoveries.length) {
        report('');
        openKodiReview(res.discoveries);
      } else if (res && res.handedTo) {
        toast(t('kodiSettings.syncHanded', { name: res.handedTo, n: Number(res.handedCount) }), 'ok');
      } else {
        const upd = res && res.updated_existing;
        toast(upd ? t('kodiSettings.syncUpdated', { n: Number(upd) }) : t('kodiSettings.syncNone'), 'ok');
      }
    } catch (err) {
      toast(err.message || t('kodiSettings.syncFailed'), 'bad');
    }
    },
  });

  section.append(heading, enableRow.el, listWrap, addRow.el, syncRow.el);

  // Icon set is loaded once and reused by every form.
  let iconList = null;
  function loadIcons() {
    if (iconList) return Promise.resolve(iconList);
    return api
      .kodiIcons()
      .then((d) => {
        iconList = d.icons || [];
        return iconList;
      })
      .catch(() => {
        iconList = [];
        return iconList;
      });
  }

  function iconUrl(file) {
    return withBase(file ? `/icons/kodi/${file}` : DEFAULT_ICON);
  }

  // Household members an instance can sync into (the master plus every member
  // who can sign in). Kodi's watched marks belong to a Kodi profile, not to a
  // person, so each instance names whose shelfit library receives them.
  let members = [];
  let everyone = []; // also disabled / not yet joined: to name a saved owner
  const membersReady = api
    .householdMembers()
    .then((d) => {
      everyone = (d && d.members) || [];
      members = everyone.filter((m) => m.role === 'master' || (m.has_password && !m.disabled));
    })
    .catch(() => {
      members = [];
      everyone = [];
    });
  const master = () => members.find((m) => m.role === 'master');
  // Where the titles really go: a saved owner who can't sign in right now falls
  // back to the master, as the server does (kodiSync.syncOwnerId).
  function syncOwnerName(inst) {
    const m = members.find((x) => x.id === inst.sync_user_id) || master();
    return m ? m.display_name : null;
  }

  // --- Rendering ----------------------------------------------------------
  function renderConfig(cfg) {
    enableRow.setChecked(!!cfg.enabled);
    listWrap.innerHTML = '';
    if (!cfg.instances.length) {
      listWrap.append(
        el('div', { class: 'muted usage-desc', text: t('kodiSettings.empty') })
      );
      return;
    }
    for (const inst of cfg.instances) {
      listWrap.append(instanceCard(inst));
    }
  }

  function instanceCard(inst) {
    // Which instance is active used to be a bare <input type="radio"> — the last
    // OS control left in Settings. It is now a chip: filled and inert on the
    // active instance, an outline button on the others.
    const activeChip = el('button', {
      class: 'kodi-active-chip' + (inst.is_active ? ' is-active' : ''),
      type: 'button',
      'aria-pressed': String(!!inst.is_active),
      text: inst.is_active ? t('kodiSettings.active') : t('kodiSettings.setActive'),
      disabled: inst.is_active ? '' : null,
    });
    activeChip.addEventListener('click', async () => {
      if (inst.is_active) return;
      activeChip.disabled = true;
      try {
        const cfg = await api.kodiActivateInstance(inst.id);
        renderConfig(cfg);
        refreshKodi();
      } catch (err) {
        toast(err.message || t('kodiSettings.failed'), 'bad');
        reload();
      }
    });

    const icon = el('img', {
      class: 'kodi-inst-icon' + (inst.icon ? '' : ' is-default'),
      src: iconUrl(inst.icon),
      alt: '',
      'aria-hidden': 'true',
    });

    // Reachability status: a fixed slot in the header row, filled by the Test
    // action. A small colored dot carries the state; the label stays muted so it
    // reads at a glance without drawing attention. Static — no badge, no animation.
    const status = el('div', { class: 'kodi-inst-status' });
    function setStatus(state) {
      status.className = 'kodi-inst-status is-' + state; // testing | online | offline
      status.innerHTML = '';
      if (state === 'testing') {
        status.append(el('span', { class: 'kodi-status-label', text: t('kodiSettings.testing') }));
        return;
      }
      status.append(
        el('span', { class: 'kodi-status-dot' }),
        el('span', { class: 'kodi-status-label', text: state === 'online' ? t('kodiSettings.online') : t('kodiSettings.unreachable') })
      );
    }

    const head = el('div', { class: 'kodi-inst-head' }, [
      icon,
      el('div', { class: 'kodi-inst-title' }, [
        el('span', { class: 'kodi-inst-name', text: inst.name }),
        el('span', {
          class: 'kodi-inst-sub',
          text:
            members.length > 1 || inst.sync_user_id
              ? `${inst.host}:${inst.port} · ${t('kodiSettings.syncsInto', { name: syncOwnerName(inst) })}`
              : `${inst.host}:${inst.port}`,
        }),
      ]),
      status,
    ]);

    const testBtn = iconAction({
      icon: 'locate-fixed',
      label: t('kodiSettings.testConnection'),
      onClick: async () => {
        setStatus('testing');
        try {
          const res = await api.kodiTest({ id: inst.id });
          setStatus(res.ok ? 'online' : 'offline');
        } catch {
          setStatus('offline');
        }
      },
    });

    // Footer: the active chip on the left, the 36px round actions on the right —
    // the same pair the Lists and Magic Links rows use.
    const foot = el('div', { class: 'kodi-inst-foot' }, [
      activeChip,
      el('div', { class: 'kodi-inst-actions row-actions' }, [
        testBtn,
        iconAction({ icon: 'square-pen', label: t('common.edit'), onClick: () => openInstanceForm(inst) }),
        iconAction({ icon: 'trash-2', label: t('common.delete'), danger: true, onClick: () => removeInstance(inst) }),
      ]),
    ]);

    return el('div', { class: 'kodi-instance' + (inst.is_active ? ' active' : '') }, [head, foot]);
  }

  // --- Add / edit form (modal) --------------------------------------------
  function openInstanceForm(inst) {
    const editing = !!inst;
    openModal((modal, close) => {
      const nameIn = el('input', { class: 'text-field', placeholder: t('kodiSettings.namePlaceholder'), value: editing ? inst.name : '' });
      const hostIn = el('input', { class: 'text-field', placeholder: t('kodiSettings.hostPlaceholder'), value: editing ? inst.host : '' });
      const portIn = el('input', { class: 'text-field', type: 'number', placeholder: t('kodiSettings.port'), value: editing ? String(inst.port) : '8080' });
      const userIn = el('input', { class: 'text-field', placeholder: t('kodiSettings.username'), value: editing ? inst.username : '' });
      const passIn = el('input', {
        class: 'text-field',
        type: 'password',
        placeholder: editing && inst.has_password ? t('kodiSettings.passwordUnchanged') : t('kodiSettings.password'),
        autocomplete: 'new-password',
      });

      // --- Icon picker ---
      let selectedIcon = editing ? inst.icon || null : null;
      const pickerGrid = el('div', { class: 'kodi-icon-picker' }, [skelLine({ width: '60%' })]);

      function renderPicker(icons) {
        pickerGrid.innerHTML = '';
        // "None" option first.
        const none = el('button', {
          class: 'kodi-icon-option kodi-icon-none' + (selectedIcon ? '' : ' selected'),
          type: 'button',
          title: t('kodiSettings.noIcon'),
          text: '∅',
        });
        none.addEventListener('click', () => {
          selectedIcon = null;
          syncPicker();
        });
        pickerGrid.append(none);

        if (!icons.length) {
          pickerGrid.append(
            el('div', { class: 'muted kodi-icon-empty', text: t('kodiSettings.noIcons') })
          );
          return;
        }
        for (const ic of icons) {
          const opt = el('button', {
            class: 'kodi-icon-option' + (selectedIcon === ic.file ? ' selected' : ''),
            type: 'button',
            title: ic.file,
            'data-file': ic.file,
          }, [el('img', { src: withBase(ic.url), alt: ic.file })]);
          opt.addEventListener('click', () => {
            selectedIcon = ic.file;
            syncPicker();
          });
          pickerGrid.append(opt);
        }
      }
      function syncPicker() {
        pickerGrid.querySelectorAll('.kodi-icon-option').forEach((b) => {
          const file = b.getAttribute('data-file');
          const isSel = b.classList.contains('kodi-icon-none') ? !selectedIcon : file === selectedIcon;
          b.classList.toggle('selected', isSel);
        });
      }
      loadIcons().then(renderPicker);

      // Whose library this instance syncs into; only worth asking when there is
      // more than one member to choose from.
      // Every option carries the member's real id (an empty value would read as
      // "nothing chosen" and leave the pill blank); the master's id is saved as
      // null, which is how the server spells "the master". A saved owner who can't
      // sign in right now stays listed, so saving the form never moves the sync
      // somewhere else behind the master's back.
      const masterId = master() ? String(master().id) : '';
      const ownerOptions = members.map((m) => ({ value: String(m.id), text: m.display_name }));
      const savedOwner = editing && inst.sync_user_id ? String(inst.sync_user_id) : masterId;
      if (savedOwner !== masterId && !ownerOptions.some((o) => o.value === savedOwner)) {
        const gone = everyone.find((m) => String(m.id) === savedOwner);
        if (gone) ownerOptions.push({ value: savedOwner, text: t('kodiSettings.ownerInactive', { name: gone.display_name }) });
      }
      const ownerPill =
        ownerOptions.length > 1
          ? selectPill({
              label: t('kodiSettings.syncOwner'),
              options: ownerOptions,
              value: savedOwner,
            })
          : null;

      const testResult = el('div', { class: 'kodi-test-result' });

      function formBody() {
        return {
          name: nameIn.value.trim(),
          host: hostIn.value.trim(),
          port: parseInt(portIn.value, 10) || 8080,
          username: userIn.value.trim(),
          password: passIn.value,
          icon: selectedIcon,
          sync_user_id: ownerPill
            ? (ownerPill.value && ownerPill.value !== masterId ? Number(ownerPill.value) : null)
            : undefined,
        };
      }

      const testBtn = el('button', { class: 'btn btn-secondary' }, [
      lucideIcon('locate-fixed', 'btn-lucide'),
      el('span', { text: t('kodiSettings.testConnection') }),
    ]);
      testBtn.addEventListener('click', async () => {
        const b = formBody();
        if (!b.host) {
          toast(t('kodiSettings.enterHost'));
          return;
        }
        testResult.textContent = t('kodiSettings.testing');
        testResult.className = 'kodi-test-result muted';
        try {
          const payload = editing && !b.password
            ? { id: inst.id, host: b.host, port: b.port, username: b.username }
            : b;
          const res = await api.kodiTest(payload);
          testResult.textContent = '● ' + (res.ok ? t('kodiSettings.online') : t('kodiSettings.unreachable'));
          testResult.className = 'kodi-test-result ' + (res.ok ? 'kodi-ok' : 'kodi-fail');
        } catch (err) {
          testResult.textContent = '● ' + (err.message || t('kodiSettings.failed'));
          testResult.className = 'kodi-test-result kodi-fail';
        }
      });

      const saveBtn = el('button', { class: 'btn btn-primary' }, [
        lucideIcon(editing ? 'check' : 'plus', 'btn-lucide'),
        el('span', { text: editing ? t('common.save') : t('common.add') }),
      ]);
      saveBtn.addEventListener('click', async () => {
        const b = formBody();
        if (!b.name || !b.host) {
          toast(t('kodiSettings.nameHostRequired'));
          return;
        }
        saveBtn.disabled = true;
        try {
          const cfg = editing
            ? await api.kodiUpdateInstance(inst.id, b)
            : await api.kodiCreateInstance(b);
          renderConfig(cfg);
          refreshKodi();
          close();
          toast(editing ? t('kodiSettings.saved') : t('kodiSettings.added'), 'ok');
        } catch (err) {
          saveBtn.disabled = false;
          toast(err.message || t('kodiSettings.failed'), 'bad');
        }
      });

      // The form is long enough to scroll, so the actions are pinned: the body
      // scrolls under the rule instead of pushing Save out of reach.
      modal.classList.add('modal--split');
      modal.append(
        el('div', { class: 'modal-body' }, [
          el('h3', { text: editing ? t('kodiSettings.editTitle') : t('kodiSettings.addTitle') }),
          el('div', { class: 'stack' }, [
            el('label', { class: 'field-label', text: t('kodiSettings.name') }), nameIn,
            el('label', { class: 'field-label', text: t('kodiSettings.host') }), hostIn,
            el('label', { class: 'field-label', text: t('kodiSettings.port') }), portIn,
            el('label', { class: 'field-label', text: t('kodiSettings.username') }), userIn,
            el('label', { class: 'field-label', text: t('kodiSettings.password') }), passIn,
            el('label', { class: 'field-label', text: t('kodiSettings.icon') }), pickerGrid,
            ownerPill ? el('label', { class: 'field-label', text: t('kodiSettings.syncOwner') }) : null,
            ownerPill ? ownerPill.el : null,
            ownerPill ? el('div', { class: 'muted usage-desc', text: t('kodiSettings.syncOwnerHint') }) : null,
          ]),
          el('div', { class: 'stack', style: { marginTop: '8px' } }, [testBtn, testResult]),
        ]),
        el('div', { class: 'modal-foot' }, [
          // Same rule above the actions that every other modal draws.
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

  async function removeInstance(inst) {
    // The app's own dialog, not the browser's — matching every other
    // destructive confirm in Settings.
    confirmModal({
      title: t('kodiSettings.deleteTitle', { name: inst.name }),
      body: t('kodiSettings.deleteBody'),
      confirmLabel: t('kodiSettings.deleteConfirm'),
      onConfirm: () => doRemoveInstance(inst),
    });
  }

  async function doRemoveInstance(inst) {
    try {
      const cfg = await api.kodiDeleteInstance(inst.id);
      renderConfig(cfg);
      refreshKodi();
    } catch (err) {
      toast(err.message || t('kodiSettings.failed'), 'bad');
      throw err; // keep the dialog open
    }
  }

  // --- Load -----------------------------------------------------------------
  function reload() {
    Promise.all([api.kodiConfig(), membersReady])
      .then(([cfg]) => renderConfig(cfg))
      .catch(() => {
        listWrap.innerHTML = '';
        listWrap.append(
          stateBlock({
            kind: 'error',
            tier: 'inline',
            title: t('kodiSettings.loadError'),
            action: { onClick: () => reload() },
          })
        );
      });
  }
  reload();

  return section;
}
