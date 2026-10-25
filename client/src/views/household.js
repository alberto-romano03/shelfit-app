// Household settings section (master only): who can sign in to this shelfit.
//
// Lists every account; the master can add a member, rename, turn sign-in off and
// on, reset a password and remove a member. A new member, or one whose password
// was reset, gets a one-time invite link: they open it and choose their own
// password, so the master never knows it. Like a magic link, the URL is shown
// exactly once, in a copyable field. The master manages accounts, never their
// contents: removing a member offers their library backup first, nothing else
// here reads a library.

import {
  el,
  toast,
  formatDate,
  skelLine,
  stateBlock,
  settingsRow,
  settingsHeader,
  settingsRule,
  openModal,
  lucideIcon,
} from '../ui.js';
import { t } from '../i18n.js';

export function buildHousehold(api) {
  const section = el('div', { class: 'settings-section household-section' });
  const listWrap = el('div', { class: 'household-list' }, [skelLine({ width: '70%' })]);
  const formWrap = el('div', { class: 'magic-form-wrap' });
  const addRow = settingsRow({ icon: 'plus', label: t('household.add'), sub: t('household.addSub') });

  section.append(
    settingsHeader('users', t('household.title')),
    el('div', { class: 'muted usage-desc', text: t('household.desc') }),
    listWrap,
    formWrap,
    addRow.el
  );

  async function refresh() {
    let data;
    try {
      data = await api.householdMembers();
    } catch {
      listWrap.innerHTML = '';
      listWrap.append(
        stateBlock({ kind: 'error', tier: 'inline', title: t('household.loadError'), action: { onClick: refresh } })
      );
      return;
    }
    listWrap.innerHTML = '';
    for (const m of (data && data.members) || []) listWrap.append(memberRow(m));
  }

  // What a member's row says under the name.
  function statusLine(m) {
    if (m.role === 'master') return t('household.status.master');
    if (m.disabled) return t('household.status.disabled');
    if (!m.has_password) {
      return m.invite_expires_at
        ? t('household.status.invited', { date: formatDate(m.invite_expires_at) })
        : t('household.status.inviteExpired');
    }
    return m.last_login_at
      ? t('household.status.lastSeen', { date: formatDate(m.last_login_at) })
      : t('household.status.member');
  }

  function memberIcon(m) {
    if (m.role === 'master') return 'badge';
    if (m.disabled) return 'circle-x';
    if (!m.has_password) return 'send';
    return 'user-round';
  }

  function memberRow(m) {
    return settingsRow({
      icon: memberIcon(m),
      label: m.display_name,
      sub: statusLine(m),
      control: 'chevron',
      onClick: () => openMember(m),
    }).el;
  }

  // --- One member's actions -------------------------------------------------
  function openMember(m) {
    openModal((modal, close) => {
      const rows = [];
      rows.push(
        settingsRow({
          icon: 'square-pen',
          label: t('household.rename'),
          onClick: () => {
            close();
            renameMember(m);
          },
        }).el
      );
      if (m.role !== 'master') {
        const signIn = settingsRow({
          icon: 'shield',
          label: t('household.canSignIn'),
          sub: t('household.canSignInSub'),
          control: 'switch',
          checked: !m.disabled,
          onChange: async (on) => {
            signIn.setDisabled(true);
            try {
              await api.updateMember(m.id, { disabled: !on });
              toast(on ? t('household.enabled', { name: m.display_name }) : t('household.disabled', { name: m.display_name }), 'ok');
              close();
              refresh();
            } catch (err) {
              signIn.setChecked(!on);
              signIn.setDisabled(false);
              toast(err.message || t('settings.failed'), 'bad');
            }
          },
        });
        rows.push(signIn.el);
        rows.push(
          settingsRow({
            icon: 'send',
            label: m.has_password ? t('household.resetPassword') : t('household.newInvite'),
            sub: m.has_password ? t('household.resetPasswordSub') : t('household.newInviteSub'),
            onClick: () => {
              close();
              if (m.has_password) confirmReset(m);
              else reinvite(m);
            },
          }).el
        );
        rows.push(settingsRule());
        rows.push(
          settingsRow({
            icon: 'trash-2',
            label: t('household.remove'),
            sub: t('household.removeSub'),
            danger: true,
            onClick: () => {
              close();
              confirmRemove(m);
            },
          }).el
        );
      }
      modal.append(
        el('h3', { text: m.display_name }),
        el('div', { class: 'muted', text: statusLine(m) }),
        el('div', { class: 'household-actions' }, rows)
      );
    });
  }

  function renameMember(m) {
    openModal((modal, close) => {
      const input = el('input', { class: 'text-field', type: 'text', maxlength: '40', value: m.display_name });
      const save = el('button', { class: 'btn btn-primary' }, [
        lucideIcon('check', 'btn-lucide'),
        el('span', { text: t('common.save') }),
      ]);
      const submit = async () => {
        const name = input.value.trim();
        if (!name) {
          input.focus();
          return;
        }
        save.disabled = true;
        try {
          await api.updateMember(m.id, { display_name: name });
          close();
          refresh();
        } catch (err) {
          save.disabled = false;
          toast(err.message || t('settings.failed'), 'bad');
        }
      };
      save.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      modal.append(
        el('h3', { text: t('household.renameTitle') }),
        input,
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: close }, [
            lucideIcon('x', 'btn-lucide'),
            el('span', { text: t('common.cancel') }),
          ]),
          save,
        ])
      );
      input.focus();
      input.select();
    });
  }

  function confirmReset(m) {
    openModal((modal, close) => {
      const go = el('button', { class: 'btn btn-primary' }, [
        lucideIcon('send', 'btn-lucide'),
        el('span', { text: t('household.resetConfirm') }),
      ]);
      go.addEventListener('click', async () => {
        go.disabled = true;
        const ok = await reinvite(m);
        if (ok) close();
        else go.disabled = false;
      });
      modal.append(
        el('h3', { text: t('household.resetTitle', { name: m.display_name }) }),
        el('div', { class: 'muted', text: t('household.resetBody') }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: close }, [
            lucideIcon('x', 'btn-lucide'),
            el('span', { text: t('common.cancel') }),
          ]),
          go,
        ])
      );
    });
  }

  async function reinvite(m) {
    try {
      const res = await api.reinviteMember(m.id);
      showInvite(res);
      refresh();
      return true;
    } catch (err) {
      toast(err.message || t('settings.failed'), 'bad');
      return false;
    }
  }

  async function downloadBackup(m) {
    const { blob, filename } = await api.exportMember(m.id);
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function confirmRemove(m) {
    openModal((modal, close) => {
      const backup = el('button', { class: 'btn btn-secondary' }, [
        lucideIcon('file-down', 'btn-lucide'),
        el('span', { text: t('household.downloadBackup') }),
      ]);
      backup.addEventListener('click', async () => {
        backup.disabled = true;
        try {
          await downloadBackup(m);
          backup.querySelector('span').textContent = t('household.backupSaved');
        } catch (err) {
          backup.disabled = false;
          toast(err.message || t('settings.backup.exportFailed'), 'bad');
        }
      });
      const go = el('button', { class: 'btn btn-danger' }, [
        lucideIcon('trash-2', 'btn-lucide'),
        el('span', { text: t('household.removeConfirm') }),
      ]);
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          await api.removeMember(m.id);
          toast(t('household.removed', { name: m.display_name }), 'ok');
          close();
          refresh();
        } catch (err) {
          go.disabled = false;
          toast(err.message || t('settings.failed'), 'bad');
        }
      });
      modal.append(
        el('h3', { text: t('household.removeTitle', { name: m.display_name }) }),
        el('div', { class: 'muted', text: t('household.removeBody') }),
        el('div', { class: 'household-backup' }, [backup]),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: close }, [
            lucideIcon('x', 'btn-lucide'),
            el('span', { text: t('common.cancel') }),
          ]),
          go,
        ])
      );
    });
  }

  // --- Add a member ----------------------------------------------------------
  function openForm() {
    addRow.el.style.display = 'none';
    formWrap.innerHTML = '';
    const input = el('input', {
      class: 'text-field',
      type: 'text',
      maxlength: '40',
      placeholder: t('household.namePlaceholder'),
    });
    const create = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('plus', 'btn-lucide'),
      el('span', { text: t('household.create') }),
    ]);
    const submit = async () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      create.disabled = true;
      try {
        const res = await api.addMember(name);
        showInvite(res);
        refresh();
      } catch (err) {
        create.disabled = false;
        toast(err.message || t('settings.failed'), 'bad');
      }
    };
    create.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    formWrap.append(
      el('div', { class: 'magic-form' }, [
        el('div', { class: 'field-label', text: t('household.name') }),
        input,
        el('div', { class: 'magic-form-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: closeForm }, [
            lucideIcon('x', 'btn-lucide'),
            el('span', { text: t('common.cancel') }),
          ]),
          create,
        ]),
      ])
    );
    input.focus();
  }

  function closeForm() {
    formWrap.innerHTML = '';
    addRow.el.style.display = '';
  }

  // The one-and-only reveal of an invite link (new member or password reset).
  function showInvite(res) {
    addRow.el.style.display = 'none';
    formWrap.innerHTML = '';
    const name = res.member ? res.member.display_name : '';
    const urlField = el('input', { class: 'text-field magic-url', type: 'text', readonly: 'readonly', value: res.invite_url });
    urlField.addEventListener('focus', () => urlField.select());
    const copy = el('button', { class: 'btn btn-secondary magic-copy' }, [
      lucideIcon('copy', 'btn-lucide'),
      el('span', { text: t('magic.copy') }),
    ]);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(res.invite_url);
      } catch {
        urlField.select();
        try {
          document.execCommand('copy');
        } catch {
          /* clipboard unavailable */
        }
      }
      const label = copy.querySelector('span');
      label.textContent = t('magic.copied');
      setTimeout(() => (label.textContent = t('magic.copy')), 1500);
    });
    const done = el('button', { class: 'btn btn-primary', onClick: closeForm }, [
      lucideIcon('check', 'btn-lucide'),
      el('span', { text: t('common.done') }),
    ]);
    formWrap.append(
      el('div', { class: 'magic-result' }, [
        el('div', { class: 'magic-result-head', text: t('household.inviteReady', { name }) }),
        el('div', {
          class: 'muted magic-result-note',
          text: t('household.inviteNote', { name, date: formatDate(res.invite_expires_at) }),
        }),
        el('div', { class: 'magic-block' }, [el('div', { class: 'magic-url-row' }, [urlField, copy])]),
        el('div', { class: 'magic-form-actions' }, [done]),
      ])
    );
    urlField.focus();
  }

  addRow.el.addEventListener('click', openForm);
  refresh();
  return section;
}
