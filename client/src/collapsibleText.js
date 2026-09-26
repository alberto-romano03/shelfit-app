// "Show more / Show less" collapsible paragraph — shared by the title detail page
// (film/series overview) and the person page (biography), so the truncation rule
// and the expand animation live in exactly one place.
//
// Animates max-height between the truncated preview and the full text, with a
// timeout fallback in case transitionend is missed.

import { el, setLabel } from './ui.js';
import { smartTruncate } from './truncate.js';
import { t } from './i18n.js';

// Returns the nodes to append: just the paragraph when the text fits, or the
// paragraph plus a toggle when it needed truncating.
export function collapsibleText(full, className = 'overview overview-collapsible') {
  if (!full) return [];
  const { text: shortText, truncated } = smartTruncate(full);
  const ov = el('div', { class: className });
  ov.style.maxHeight = 'none'; // no CSS clamp — the preview is already sized
  ov.textContent = truncated ? shortText : full;
  if (!truncated) return [ov];

  const toggle = el('div', { class: 'overview-toggle', text: t('common.showMore') });
  let expanded = false;
  let animating = false;

  // Land the final text once the box has finished moving. Only the COLLAPSE
  // needs this (see below); expanding already holds the full text throughout.
  const finish = (onEnd) => {
    if (!animating) return;
    animating = false;
    ov.removeEventListener('transitionend', onEnd);
    if (!expanded) ov.textContent = shortText; // box is small now — trim to the preview
    ov.style.maxHeight = 'none'; // natural height after the animation
  };

  toggle.addEventListener('click', () => {
    if (animating) return;
    animating = true;
    const from = ov.offsetHeight; // current height (preview or full)
    expanded = !expanded;
    // Crossfade the label NOW, alongside the height animation — not when the
    // expansion finishes. Deferring it left the old text sitting there for the
    // whole ~280ms expand, so the swap read as a late, disconnected flicker
    // rather than part of the same gesture.
    setLabel(toggle, expanded ? t('text.showLess') : t('common.showMore'));

    // Measure the height the box is heading TO, then decide what text to show
    // while it travels.
    //
    // Expanding: keep the full text in place. The box clips it and the extra
    // lines are REVEALED as max-height grows — which is why that direction has
    // always looked right.
    //
    // Collapsing: the full text must stay too, so the shrinking box wipes over
    // it. Swapping to the truncated copy up front (what this used to do) made
    // the words vanish in one frame and left an empty box animating shut after
    // them — the same height animation, but nothing moving inside it. The
    // truncated copy goes in at the end instead, in finish().
    ov.textContent = full;
    ov.style.maxHeight = 'none';
    const to = expanded ? ov.offsetHeight : measure(shortText);
    ov.style.maxHeight = from + 'px';
    void ov.offsetHeight; // reflow so the next change animates
    ov.style.maxHeight = to + 'px';
    const onEnd = (e) => {
      if (e.propertyName === 'max-height') finish(onEnd);
    };
    ov.addEventListener('transitionend', onEnd);
    setTimeout(() => finish(onEnd), 400); // fallback if transitionend is missed (> --dur-medium)
  });

  // Natural height of `text` in this element, measured without disturbing what
  // is currently rendered (the collapse needs the preview's height while the
  // full text is still on screen).
  function measure(text) {
    const prev = ov.textContent;
    ov.textContent = text;
    const h = ov.offsetHeight;
    ov.textContent = prev;
    return h;
  }

  return [ov, toggle];
}
