// Devices settings subsection: where the signed-in member is signed in.
//
// One row per live session (a coarse "Browser on OS" label, never the raw
// user-agent), newest activity first. Any other device can be signed out from
// here; this device signs out with the Log out row above instead.

import { el, toast, formatDate, skelLine, stateBlock, settingsRow, settingsHeader, iconAction } from '../ui.js';
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
      listWrap.innerHTML = '';
      listWrap.append(
        stateBlock({ kind: 'error', tier: 'inline', title: t('devices.loadError'), action: { onClick: refresh } })
      );
      return;
    }
    listWrap.innerHTML = '';
    for (const s of (data && data.sessions) || []) listWrap.append(sessionRow(s));
  }

  function sessionRow(s) {
    const end = s.current
      ? null
      : iconAction({
          icon: 'log-out',
          label: t('devices.signOut'),
          danger: true,
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await api.revokeSession(s.id);
              toast(t('devices.signedOut'), 'ok');
              refresh();
            } catch (err) {
              btn.disabled = false;
              toast(err.message || t('settings.failed'), 'bad');
            }
          },
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
