// Devices settings subsection: where the signed-in member is signed in.
//
// One row per live session (a coarse "Browser on OS" label, never the raw
// user-agent), newest activity first. Any other device can be signed out from
// here; this device signs out with the Log out row above instead.

import { el, toast, formatDate, skelLine, stateBlock, settingsRow, settingsHeader, iconAction, confirmModal } from '../ui.js';
import { t } from '../i18n.js';

const MOBILE = /iPhone|iPad|Android/;

export function buildDevices(api) {
  const section = el('div', { class: 'settings-section devices-section' });
  const listWrap = el('div', { class: 'devices-list' }, [skelLine({ width: '60%' })]);
  section.append(
    settingsHeader('smartphone', t('devices.title')),
    el('div', { class: 'muted usage-desc', text: t('devices.desc') }),
    listWrap
  );

  async function refresh() {
    let data;
    try {
      data = await api.sessions();
    } catch {
      listWrap.replaceChildren();
      listWrap.append(
        stateBlock({ kind: 'error', tier: 'inline', title: t('devices.loadError'), action: { onClick: refresh } })
      );
      return;
    }
    listWrap.replaceChildren();
    for (const s of (data && data.sessions) || []) listWrap.append(sessionRow(s));
  }

  function sessionRow(s) {
    // This device has no action: an empty end keeps its row a plain line, not
    // a button that does nothing. Another device's sign-out is asked first.
    const end = s.current
      ? []
      : iconAction({
          icon: 'log-out',
          label: t('devices.signOut'),
          danger: true,
          onClick: () =>
            confirmModal({
              title: t('devices.signOutTitle', { name: s.label || t('devices.unknown') }),
              body: t('devices.signOutBody'),
              confirmLabel: t('devices.signOut'),
              confirmIcon: 'log-out',
              onConfirm: async () => {
                try {
                  await api.revokeSession(s.id);
                } catch (err) {
                  toast(err.message || t('settings.failed'), 'bad');
                  throw err; // keeps the question open
                }
                toast(t('devices.signedOut'), 'ok');
                refresh();
              },
            }),
        });
    return settingsRow({
      icon: MOBILE.test(s.label || '') ? 'smartphone' : 'earth',
      label: s.label || t('devices.unknown'),
      sub: s.current ? t('devices.thisDevice') : t('devices.lastActive', { date: formatDate(s.last_seen_at) }),
      end,
    }).el;
  }

  refresh();
  return section;
}
