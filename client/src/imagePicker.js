// "Customize metadata" - replacing a title's poster, backdrop or disc art with
// an image the user picks, either from TMDB / Fanart.tv or from their own
// device. Opened from the Detail options menu.
//
// One modal, several steps: type -> source -> browse or file picker -> crop ->
// save. Each step replaces the last inside the same sheet, so the flow never
// stacks popups.
//
// The crop happens here, not on the server: the frame is locked to the slot's
// aspect ratio and the image is panned and zoomed behind it, so what the server
// receives is already exactly the shape the slot needs. It only compresses and
// stores it (see server/routes/images.js).
import { el, openModal, toast, lucideIcon, icons } from './ui.js';
import { t } from './i18n.js';
import { withBase } from './basePath.js';

// ratio - the crop frame's aspect, locked per slot
// out   - the pixel size sent to the server, matching what the cache stores
//         (poster maxWidth 500, backdrop 900, disc art 640)
// `provider` is only a label and a logo: the server decides where candidates
// actually come from. TMDB holds no disc art, so that slot browses Fanart.tv,
// the same source the automatic disc picker already uses.
const TMDB = { label: 'images.fromTmdb', logo: '/icons/tmdb/tmdb-logo.svg' };
const FANART = { label: 'images.fromFanart', logo: '/icons/fanart/fanart-logo.svg' };

const SLOTS = [
  { key: 'poster', ratio: 2 / 3, out: [500, 750], art: 'imgart-poster', provider: TMDB },
  { key: 'backdrop', ratio: 16 / 9, out: [900, 506], art: 'imgart-backdrop', provider: TMDB },
  { key: 'fanart', ratio: 1, out: [600, 600], art: 'imgart-disc', provider: FANART },
];

const slotLabel = (key) => t(`images.slot.${key}`);

export function openImagePicker(item, api, onChanged) {
  // Which slots currently carry the user's own image. Filled from the first
  // browse response and kept in step with every save and reset.
  const custom = { poster: false, backdrop: false, fanart: false };
  let changed = false;

  openModal((modal, close) => {
    const stage = el('div', { class: 'imgflow' });
    modal.append(stage);

    // Swap the visible step. The outgoing one is taken out of flow and faded
    // while the incoming one fades in, so the sheet eases to its new height
    // instead of jumping.
    let current = null;
    function show(build) {
      const next = el('div', { class: 'imgflow-step' });
      build(next);
      if (current) {
        const old = current;
        stage.style.minHeight = `${stage.offsetHeight}px`;
        old.classList.add('is-leaving');
        setTimeout(() => old.remove(), 240);
      }
      stage.append(next);
      current = next;
      requestAnimationFrame(() => {
        stage.style.minHeight = '';
      });
    }

    function head(parent, title, onBack) {
      const row = el('div', { class: 'imgflow-head' });
      if (onBack) {
        row.append(
          el('button', {
            class: 'imgflow-back',
            'aria-label': t('common.back'),
            html: icons.back,
            onClick: onBack,
          })
        );
      }
      row.append(el('div', { class: 'imgflow-title', text: title }));
      parent.append(row);
    }

    function actions(parent, buttons) {
      const row = el('div', { class: 'modal-actions' });
      buttons.forEach(({ cls, icon, label, onClick }) => {
        row.append(
          el('button', { class: `btn ${cls}`, onClick }, [
            lucideIcon(icon, 'btn-lucide'),
            el('span', { text: label }),
          ])
        );
      });
      parent.append(row);
    }

    // Closing reloads the detail view only when something actually changed, so
    // a look-and-cancel costs nothing. The retained Detail DOM was already
    // dropped by the save itself: api.js fires 'shelfit:library-changed' on every
    // non-GET, so the reload rebuilds from the new payload rather than
    // re-attaching nodes that still point at the old image URLs.
    function done() {
      close();
      if (changed && onChanged) onChanged();
    }

    // ---- Step 1: which image ----
    function stepSlot(root) {
      head(root, t('images.title'));
      root.append(el('div', { class: 'imgflow-sub', text: t('images.intro') }));

      const grid = el('div', { class: 'imgtype-grid' });
      SLOTS.forEach((slot) => {
        grid.append(
          el(
            'button',
            { class: 'imgtype-cell', onClick: () => show((r) => stepSource(r, slot)) },
            [
              // Always the illustration, never a thumbnail of the chosen image:
              // the three shapes are what makes the row readable at a glance.
              el('div', { class: 'imgart' }, [el('div', { class: `imgart-shape ${slot.art}` })]),
              el('div', { class: 'imgtype-label', text: slotLabel(slot.key) }),
              el('div', {
                class: 'imgtype-state' + (custom[slot.key] ? ' is-custom' : ''),
                text: custom[slot.key] ? t('images.state.custom') : t('images.state.default'),
              }),
            ]
          )
        );
      });
      root.append(grid);

      // One reset row per overridden slot, only while it is overridden.
      SLOTS.forEach((slot) => {
        if (!custom[slot.key]) return;
        const row = el('button', { class: 'imgreset-row' }, [
          lucideIcon('refresh-cw', 'imgreset-ico'),
          el('span', { text: t('images.reset', { name: slotLabel(slot.key) }) }),
        ]);
        row.addEventListener('click', async () => {
          row.disabled = true;
          try {
            await api.resetCustomImage(item.type, item.tmdb_id, slot.key);
            custom[slot.key] = false;
            changed = true;
            toast(t('images.resetDone', { name: slotLabel(slot.key) }), 'ok');
            show(stepSlot);
          } catch (err) {
            row.disabled = false;
            toast(err.message, 'bad');
          }
        });
        root.append(row);
      });

      root.append(el('hr', { class: 'status-sep' }));
      actions(root, [
        { cls: 'btn-secondary', icon: 'x', label: t('common.close'), onClick: done },
      ]);
    }

    // ---- Step 2: where from ----
    function stepSource(root, slot) {
      head(root, slotLabel(slot.key), () => show(stepSlot));
      const grid = el('div', { class: 'status-bento imgsrc-grid' });

      // The provider's own mark rather than a generic glyph, as on the detail
      // page's "View on TMDB" button.
      grid.append(
        el('button', { class: 'status-cell', onClick: () => show((r) => stepBrowse(r, slot)) }, [
          el('img', {
            class: 'imgsrc-logo',
            src: withBase(slot.provider.logo),
            alt: '',
            'aria-hidden': 'true',
          }),
          el('span', { class: 'status-cell-label', text: t(slot.provider.label) }),
        ])
      );

      // A plain file input: the OS picker, nothing custom.
      const input = el('input', { type: 'file', accept: 'image/*', class: 'imgsrc-file' });
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        show((r) => stepCrop(r, slot, url, () => URL.revokeObjectURL(url)));
      });
      grid.append(
        el('button', { class: 'status-cell', onClick: () => input.click() }, [
          lucideIcon('image-up', 'status-ico'),
          el('span', { class: 'status-cell-label', text: t('images.fromDevice') }),
        ])
      );

      root.append(grid, input, el('hr', { class: 'status-sep' }));
      actions(root, [
        {
          cls: 'btn-secondary',
          icon: 'x',
          label: t('common.cancel'),
          onClick: () => show(stepSlot),
        },
      ]);
    }

    // ---- Step 3: browse what the provider has ----
    function stepBrowse(root, slot) {
      head(root, slotLabel(slot.key), () => show((r) => stepSource(r, slot)));

      const grid = el('div', { class: `imgpick-grid imgpick-grid--${slot.key}` });
      const busy = el('div', { class: 'imgflow-busy' }, [
        el('div', { class: 'imgflow-spin' }),
        el('span', { text: t('images.loading') }),
      ]);
      root.append(busy, grid, el('hr', { class: 'status-sep' }));
      actions(root, [
        {
          cls: 'btn-secondary',
          icon: 'x',
          label: t('common.cancel'),
          onClick: () => show((r) => stepSource(r, slot)),
        },
      ]);

      api
        .imageCandidates(item.type, item.tmdb_id, slot.key)
        .then((res) => {
          busy.remove();
          custom[slot.key] = !!res.custom;
          const list = res.candidates || [];
          if (!list.length) {
            grid.replaceWith(el('div', { class: 'imgflow-empty', text: t('images.none') }));
            return;
          }
          list.forEach((c) => {
            const cell = el('button', { class: 'imgpick-item' }, [
              el('img', { src: c.thumb, alt: '', loading: 'lazy' }),
            ]);
            cell.addEventListener('click', () => show((r) => stepCrop(r, slot, c.url)));
            grid.append(cell);
          });
        })
        .catch((err) => {
          busy.remove();
          grid.replaceWith(el('div', { class: 'imgflow-empty', text: err.message }));
        });
    }

    // ---- Step 4: crop ----
    function stepCrop(root, slot, src, cleanup) {
      const back = () => {
        if (cleanup) cleanup();
        show((r) => stepSource(r, slot));
      };
      head(root, t('images.cropTitle', { name: slotLabel(slot.key).toLowerCase() }), back);

      const frame = el('div', {
        class: 'crop-stage' + (slot.key === 'fanart' ? ' crop-stage--round' : ''),
      });
      frame.style.setProperty('--crop-ar', String(slot.ratio));
      const canvas = el('canvas');
      frame.append(canvas, el('div', { class: 'crop-guides' }));

      const range = el('input', {
        type: 'range',
        class: 'crop-range',
        min: '100',
        max: '300',
        value: '100',
        'aria-label': t('images.zoom'),
      });

      root.append(
        frame,
        el('div', { class: 'crop-hint', text: t('images.cropHint') }),
        el('div', { class: 'crop-zoom' }, [
          lucideIcon('zoom-out', 'crop-zoom-ico'),
          range,
          lucideIcon('zoom-in', 'crop-zoom-ico'),
        ]),
        el('hr', { class: 'status-sep' })
      );

      const cropper = createCropper(canvas, frame, range, slot.ratio);
      cropper.load(src);

      const confirm = el('button', { class: 'btn btn-primary' }, [
        lucideIcon('check', 'btn-lucide'),
        el('span', { text: t('ui.confirm.label') }),
      ]);
      confirm.addEventListener('click', async () => {
        const image = cropper.export(slot.out[0], slot.out[1]);
        if (!image) {
          toast(t('images.cropFailed'), 'bad');
          return;
        }
        if (cleanup) cleanup();
        show((r) => stepSaving(r, slot, image));
      });

      const row = el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: back }, [
          lucideIcon('x', 'btn-lucide'),
          el('span', { text: t('common.cancel') }),
        ]),
        confirm,
      ]);
      root.append(row);
    }

    // ---- Step 5: hand it to the server ----
    function stepSaving(root, slot, image) {
      head(root, slotLabel(slot.key));
      root.append(
        el('div', { class: 'imgflow-busy' }, [
          el('div', { class: 'imgflow-spin' }),
          el('span', { text: t('images.saving') }),
        ])
      );
      api
        .setCustomImage(item.type, item.tmdb_id, slot.key, image)
        .then(() => {
          custom[slot.key] = true;
          changed = true;
          toast(t('images.saved', { name: slotLabel(slot.key) }), 'ok');
          show(stepSlot);
        })
        .catch((err) => {
          toast(err.message, 'bad');
          show(stepSlot);
        });
    }

    show(stepSlot);
  });
}

// --- Crop engine ----------------------------------------------------------
// The frame IS the viewport: it is locked to the slot's ratio and the image is
// panned and zoomed behind it, so there is only ever one thing to manipulate and
// the export is always exactly the right shape. Scale is clamped so the image
// always covers the frame, which makes a transparent edge impossible.
function createCropper(canvas, frame, range, ratio) {
  const ctx = canvas.getContext('2d');
  let img = null;
  let baseScale = 1; // the scale at which the image exactly covers the frame
  let scale = 1;
  let ox = 0;
  let oy = 0; // image top-left, in CSS px relative to the frame
  let vw = 0;
  let vh = 0; // frame size in CSS px

  function measure() {
    const r = frame.getBoundingClientRect();
    vw = r.width;
    vh = r.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clamp() {
    ox = Math.min(0, Math.max(vw - img.naturalWidth * scale, ox));
    oy = Math.min(0, Math.max(vh - img.naturalHeight * scale, oy));
  }

  function draw() {
    if (!img) return;
    ctx.clearRect(0, 0, vw, vh);
    ctx.drawImage(img, ox, oy, img.naturalWidth * scale, img.naturalHeight * scale);
  }

  // Zoom about an anchor (the pointer, or the frame centre for the slider) so
  // whatever is under it stays put.
  function setScale(next, anchorX, anchorY) {
    if (!img) return;
    const prev = scale;
    scale = Math.max(baseScale, Math.min(baseScale * 3, next));
    const ax = anchorX == null ? vw / 2 : anchorX;
    const ay = anchorY == null ? vh / 2 : anchorY;
    ox = ax - ((ax - ox) * scale) / prev;
    oy = ay - ((ay - oy) * scale) / prev;
    clamp();
    draw();
    range.value = String(Math.round((scale / baseScale) * 100));
  }

  const pointers = new Map();
  let lastMid = null;
  let lastDist = 0;

  frame.addEventListener('pointerdown', (e) => {
    try {
      frame.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastMid = null;
    lastDist = 0;
  });
  frame.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !img) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      ox += e.clientX - prev.x;
      oy += e.clientY - prev.y;
      clamp();
      draw();
      return;
    }
    // Two fingers: pan by the midpoint, zoom by the distance between them.
    const pts = [...pointers.values()];
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (lastMid) {
      ox += mid.x - lastMid.x;
      oy += mid.y - lastMid.y;
      const r = frame.getBoundingClientRect();
      if (lastDist > 0) setScale(scale * (dist / lastDist), mid.x - r.left, mid.y - r.top);
      else {
        clamp();
        draw();
      }
    }
    lastMid = mid;
    lastDist = dist;
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      lastMid = null;
      lastDist = 0;
    }
  };
  frame.addEventListener('pointerup', release);
  frame.addEventListener('pointercancel', release);

  frame.addEventListener(
    'wheel',
    (e) => {
      if (!img) return;
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      setScale(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false }
  );

  range.addEventListener('input', () => setScale((baseScale * Number(range.value)) / 100));

  return {
    load(src) {
      img = new Image();
      // TMDB and Fanart both serve permissive CORS headers; without this the
      // canvas would be tainted and the export would throw.
      img.crossOrigin = 'anonymous';
      img.addEventListener('load', () => {
        measure();
        baseScale = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
        scale = baseScale;
        ox = (vw - img.naturalWidth * scale) / 2;
        oy = (vh - img.naturalHeight * scale) / 2;
        range.value = '100';
        draw();
      });
      img.src = src;
    },
    // The visible frame, re-rendered at the slot's output size. This is all the
    // server ever sees, so it never has to crop.
    export(outW, outH) {
      if (!img || !img.naturalWidth) return null;
      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const octx = out.getContext('2d');
      octx.imageSmoothingQuality = 'high';
      const k = outW / vw; // frame px -> output px
      try {
        octx.drawImage(img, ox * k, oy * k, img.naturalWidth * scale * k, img.naturalHeight * scale * k);
        return out.toDataURL('image/jpeg', 0.92);
      } catch {
        return null; // tainted canvas - the source refused CORS
      }
    },
  };
}
