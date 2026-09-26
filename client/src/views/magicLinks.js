// Magic Links settings subsection — passwordless login links for other devices.
//
// Lists active links (label / expiry / last used / use count), generates a new
// one (optional label + expiry chip), and revokes existing ones. The full URL
// is shown EXACTLY once, right after creation — the server never returns the
// token again — so it goes into a copyable field with a Copy button until the
// user dismisses it.

import {
  el,
  toast,
  formatDate,
  skelLine,
  segmentedBar,
  stateBlock,
  settingsRow,
  settingsHeader,
  iconAction,
  lucideIcon,
} from '../ui.js';
import { t } from '../i18n.js';

// A function, not a constant: the labels are translated at render time.
const expiryChips = () => [
  ['7d', t('magic.expiry.days7')],
  ['30d', t('magic.expiry.days30')],
  ['90d', t('magic.expiry.days90')],
  ['1y', t('magic.expiry.year1')],
];

export function buildMagicLinks(api) {
  const section = el('div', { class: 'settings-section magic-section' });

  const listWrap = el('div', { class: 'magic-list' }, [skelLine({ width: '70%' })]);
  const formWrap = el('div', { class: 'magic-form-wrap' });
  const genRow = settingsRow({
    icon: 'plus',
    label: t('magic.generateNew'),
    sub: t('magic.generateNewSub'),
  });
  const genBtn = genRow.el;

  section.append(
    settingsHeader('link', t('magic.title')),
    el('div', {
      class: 'muted usage-desc',
      text: t('magic.desc'),
    }),
    listWrap,
    formWrap,
    genBtn
  );

  // --- Render the list of existing links ---
  async function refresh() {
    let data;
    try {
      data = await api.magicLinks();
    } catch {
      listWrap.innerHTML = '';
      listWrap.append(
        stateBlock({
          kind: 'error',
          tier: 'inline',
          title: t('magic.loadError'),
          action: { onClick: () => refresh() },
        })
      );
      return;
    }
    const links = (data && data.links) || [];
    listWrap.innerHTML = '';
    if (!links.length) {
      listWrap.append(el('div', { class: 'muted usage-desc', text: t('magic.empty') }));
      return;
    }
    links.forEach((l) => listWrap.append(linkRow(l)));
  }

  function linkRow(l) {
    const meta = [
      t('magic.expires', { date: formatDate(l.expires_at) }),
      l.last_used_at ? t('magic.lastUsed', { date: formatDate(l.last_used_at) }) : t('magic.neverUsed'),
      t('magic.uses', { n: l.use_count }),
    ].join('  ·  ');

    // The shared destructive icon action — a real 36px target, and the same
    // shape the Lists rows use for delete.
    const revoke = iconAction({
      icon: 'trash-2',
      label: t('magic.revoke'),
      danger: true,
      onClick: async () => {
        revoke.disabled = true;
        try {
          await api.revokeMagic(l.id);
          toast(t('magic.revoked'), 'ok');
          refresh();
        } catch (err) {
          revoke.disabled = false;
          toast(err.message || t('magic.revokeFailed'), 'bad');
        }
      },
    });

    return settingsRow({
      icon: 'link',
      label: l.label || t('magic.unlabeled'),
      sub: meta,
      end: revoke,
    }).el;
  }

  // --- Inline generate form ---
  let expiry = '30d';
  function openForm() {
    genBtn.style.display = 'none';
    formWrap.innerHTML = '';
    expiry = '30d';

    const labelInput = el('input', {
      class: 'text-field',
      type: 'text',
      maxlength: '60',
      placeholder: t('magic.labelPlaceholder'),
    });

    // Expiry — a single choice, so the app's segmented track rather than a row of
    // loose chips. The scrolling variant is used because four content-width
    // options fit a phone comfortably while four equal columns would not.
    const expiryBar = segmentedBar({
      options: expiryChips(),
      value: expiry,
      ariaLabel: t('magic.expiryAria'),
      onChange: (val) => {
        expiry = val;
      },
    });
    const chips = expiryBar.el;
    chips.classList.add('magic-expiry');

    const generate = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('plus', 'btn-lucide'),
      el('span', { text: t('magic.generate') }),
    ]);
    const cancel = el('button', { class: 'btn btn-secondary', onClick: closeForm }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]);
    generate.addEventListener('click', async () => {
      generate.disabled = true;
      try {
        const link = await api.createMagic(labelInput.value.trim(), expiry);
        showResult(link);
      } catch (err) {
        generate.disabled = false;
        toast(err.message || t('magic.generateFailed'), 'bad');
      }
    });

    formWrap.append(
      el('div', { class: 'magic-form' }, [
        el('div', { class: 'field-label', text: t('magic.label') }),
        labelInput,
        el('div', { class: 'field-label', text: t('magic.expiresAfter') }),
        chips,
        el('div', { class: 'magic-form-actions' }, [cancel, generate]),
      ])
    );
    labelInput.focus();
  }

  function closeForm() {
    formWrap.innerHTML = '';
    genBtn.style.display = '';
  }

  // The one-and-only reveal of the full URL. Opening it on any device signs that
  // device in and drops it straight into the app; the server never returns the
  // token again, so it is shown once in a copyable field.
  function showResult(link) {
    formWrap.innerHTML = '';

    const urlField = el('input', {
      class: 'text-field magic-url',
      type: 'text',
      readonly: 'readonly',
      value: link.url,
    });
    urlField.addEventListener('focus', () => urlField.select());

    const copy = el('button', { class: 'btn btn-secondary magic-copy' }, [
      lucideIcon('copy', 'btn-lucide'),
      el('span', { text: t('magic.copy') }),
    ]);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link.url);
      } catch {
        urlField.select();
        try {
          document.execCommand('copy');
        } catch {
          /* clipboard unavailable */
        }
      }
      // The label span, not the button — the button also holds the glyph.
      const copyLabel = copy.querySelector('span');
      copyLabel.textContent = t('magic.copied');
      setTimeout(() => (copyLabel.textContent = t('magic.copy')), 1500);
    });

    const done = el(
      'button',
      {
        class: 'btn btn-primary',
        onClick: () => {
          closeForm();
          refresh();
        },
      },
      [lucideIcon('check', 'btn-lucide'), el('span', { text: t('common.done') })]
    );

    formWrap.append(
      el('div', { class: 'magic-result' }, [
        el('div', { class: 'magic-result-head', text: t('magic.ready') }),
        el('div', { class: 'muted magic-result-note', text: t('magic.readyNote') }),

        el('div', { class: 'magic-block' }, [
          el('div', { class: 'magic-url-row' }, [urlField, copy]),
        ]),

        el('div', { class: 'magic-form-actions' }, [done]),
      ])
    );
    urlField.focus();
  }

  genBtn.addEventListener('click', openForm);
  refresh();
  return section;
}
