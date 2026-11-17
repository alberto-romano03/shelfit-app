// The Now Playing toast's action row: one line under [poster | text] that records
// what Kodi is playing in the signed-in member's library.
//   • a shelved movie → a rewatch dated today; any other status → on the shelf
//   • an episode not seen → marked; seen → its watch count plus one
//   • not in the library (with a TMDB id) → added: a movie on the shelf, a series
//     as Watching with this episode marked
// When the title or the episode can't be told for sure (Kodi numbering an episode
// differently from TMDB, one not out yet, nothing to go on), the row says why
// instead. After a tap it turns into a "done" line with Undo, and a title already
// counted today shows that, so reopening the toast never counts it twice.
//
// The server works out the match (see nowPlaying in server/kodi.js): match.status,
// seen, plays, confidence ('id' | 'title'), uncertain, done_today, rewatch_id.

import { el, lucideIcon, toast } from './ui.js';
import { api } from './api.js';
import { t, getLang } from './i18n.js';
import { navigate } from './router.js';
import { offerShelve } from './finishSeries.js';
import { refreshNowPlaying } from './kodi.js';
import { markTitleChanged } from './titleSync.js';

const epCode = (np) => `S${String(np.season || 0).padStart(2, '0')} E${String(np.episode || 0).padStart(2, '0')}`;
// "3ª" / "3rd": the time this viewing would be.
function nth(n) {
  if (getLang() === 'it') return `${n}ª`;
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
}
// A film as its detail had it before an action, so its Undo puts back the watch
// date and the stopped minute too (the server's triggers change them).
async function filmBefore(itemId) {
  const d = await api.mediaDetail(itemId);
  return { status: d.status, watch_date: d.watch_date, stopped_at: d.stopped_at, updated_at: d.updated_at };
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// What the row offers for this snapshot: an action { icon, label, aside?, run,
// undo }, a done line { done, undo? } or a note { note, link? }.
function planFor(np) {
  const m = np.match;
  const isEp = np.media_type === 'episode';
  const ep = epCode(np);
  if (!m) {
    if (!np.tmdb_id || (np.media_type !== 'movie' && !isEp)) return { note: t('nowPlaying.notInLibrary') };
    let added = null;
    return {
      icon: 'plus',
      label: isEp && np.season > 0 && np.episode > 0 ? t('nowPlaying.addSeries', { ep }) : t('nowPlaying.addMovie'),
      run: async () => {
        const res = await api.addMedia(np.tmdb_id, isEp ? 'show' : 'movie', isEp ? 'watching' : 'completed');
        added = res && (res.id || res.item_id);
        if (isEp && added && np.season > 0 && np.episode > 0) await api.markEpisode(added, np.season, np.episode);
        return t('nowPlaying.doneAdded');
      },
      undo: () => (added ? api.deleteMedia(added) : null),
      item: () => added,
    };
  }
  if (isEp && m.uncertain) {
    return {
      note: t(m.uncertain === 'not_aired' ? 'nowPlaying.notAired' : 'nowPlaying.notInTmdb', { ep }),
      link: { label: t('nowPlaying.openSeries'), go: () => navigate(`/detail/${m.item_id}`) },
    };
  }
  if (m.done_today) {
    let undo = null;
    if (isEp) undo = () => api.setEpisodeCount(m.item_id, np.season, np.episode, Math.max(0, (m.plays || 1) - 1));
    else if (m.rewatch_id) undo = () => api.deleteRewatch(m.item_id, m.rewatch_id);
    return { done: t('nowPlaying.already'), undo };
  }
  if (!isEp) {
    if (m.status === 'completed') {
      const next = (m.plays || 1) + 1;
      let rewatchId = null;
      let before = null;
      return {
        icon: 'refresh-cw',
        label: t('nowPlaying.rewatchMovie'),
        aside: t('nowPlaying.nth', { nth: nth(next) }),
        run: async () => {
          before = await filmBefore(m.item_id);
          const res = await api.addRewatch(m.item_id, todayISO());
          rewatchId = res && res.rewatch_id;
          return t('nowPlaying.doneTimes', { n: next });
        },
        // A rewatch clears the minute it was stopped at: it comes back too.
        undo: async () => {
          if (!rewatchId) return;
          await api.deleteRewatch(m.item_id, rewatchId);
          if (before) await api.restoreMovie(m.item_id, before);
        },
      };
    }
    let before = null;
    return {
      icon: 'library-big',
      label: t('nowPlaying.shelve'),
      run: async () => {
        before = await filmBefore(m.item_id);
        await api.updateMedia(m.item_id, { status: 'completed' });
        return t('nowPlaying.doneShelved');
      },
      // Back as it was: the status, and the watch date and the minute the shelf
      // stamped and cleared.
      undo: () => (before ? api.restoreMovie(m.item_id, before) : api.updateMedia(m.item_id, { status: m.status })),
    };
  }
  const count = m.plays || 0;
  if (!m.seen) {
    let marked = null;
    let prompt = null;
    return {
      icon: 'check',
      label: t('nowPlaying.markEp', { ep }),
      run: async () => {
        marked = await api.markEpisode(m.item_id, np.season, np.episode);
        // A series off the list starts being watched; a shelved one is offered
        // back to Watching; the last episode of an ended one, the shelf.
        prompt = offerShelve(marked, { id: m.item_id }) || null;
        return t('nowPlaying.doneEp', { ep });
      },
      // Everything the mark did goes back: the episode, the season it made
      // current, and a series it moved off the list to Watching. A prompt it
      // opened no longer applies.
      undo: async () => {
        if (prompt && prompt.close) prompt.close();
        await api.undoMarks(
          m.item_id,
          [{ season: np.season, episode: np.episode }],
          marked ? marked.previous_current_season ?? null : null,
          marked && marked.status_changed ? 'plan_to_watch' : undefined
        );
      },
    };
  }
  return {
    icon: 'refresh-cw',
    label: t('nowPlaying.rewatchEp', { ep }),
    aside: t('nowPlaying.nth', { nth: nth(count + 1) }),
    run: async () => {
      await api.setEpisodeCount(m.item_id, np.season, np.episode, count + 1);
      return t('nowPlaying.doneTimes', { n: count + 1 });
    },
    undo: () => api.setEpisodeCount(m.item_id, np.season, np.episode, count),
  };
}

// The row is rebuilt on every snapshot, except while an action runs or once it is
// done for the same title: a poll arriving meanwhile must not wipe the done line.
let state = { key: null, done: null, undo: null, busy: false };

export function fillActions(row, np, { onBusy } = {}) {
  // What is playing, as Kodi reports it: the same before and after an Add gives
  // the title a library id, so the done line and its Undo survive that.
  const key = [np.media_type, np.tmdb_id, np.show_title || np.title, np.season, np.episode].join('|');
  if (state.key === key && (state.busy || state.done)) return;
  if (state.key !== key) state = { key, done: null, undo: null, busy: false };
  const plan = planFor(np);
  // A poll every few seconds brings the same snapshot: keep the row as it is, so
  // a tap landing as it arrives still finds its button (and the language, which
  // the words carry, still refreshes it).
  const m = np.match || {};
  const sig = [key, plan.note, plan.done, plan.label, plan.aside, m.confidence, m.rewatch_id].join('|');
  if (row._sig === sig && row.childNodes.length) return;
  row._sig = sig;
  row.replaceChildren();
  row.className = 'np-act';

  if (plan.note) {
    row.classList.add('is-note');
    row.append(lucideIcon('info', 'btn-lucide np-act-ico'), el('span', { class: 'np-act-note', text: plan.note }));
    if (plan.link) row.append(linkButton(plan.link.label, plan.link.go));
    return;
  }
  if (plan.done) {
    showDone(row, plan.done, plan.undo, () => m.item_id);
    return;
  }

  // The title an action or its Undo changes, so a Season or title page open on it
  // reloads (titleSync.js). An Add only knows it once the title is added.
  const itemOf = plan.item || (() => m.item_id);

  const btn = el('button', { class: 'np-act-btn', type: 'button' }, [
    lucideIcon(plan.icon, 'btn-lucide np-act-ico'),
    el('span', { class: 'np-act-label', text: plan.label }),
    plan.aside ? el('span', { class: 'np-act-aside', text: plan.aside }) : null,
  ].filter(Boolean));
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (state.busy) return;
    state.busy = true;
    btn.classList.add('busy');
    if (onBusy) onBusy();
    try {
      const doneText = await plan.run();
      state.done = doneText;
      state.undo = plan.undo;
      showDone(row, doneText, plan.undo, itemOf);
      markTitleChanged(itemOf());
      refreshNowPlaying();
    } catch (err) {
      toast((err && err.message) || t('nowPlaying.failed'), 'bad');
      btn.classList.remove('busy');
    } finally {
      state.busy = false;
    }
  });
  row.append(btn);
  if (np.match && np.match.confidence === 'title') {
    row.append(el('div', { class: 'np-act-hint', text: t('nowPlaying.byTitle') }));
  }
}

function linkButton(label, onClick) {
  return el('button', {
    class: 'np-act-link',
    type: 'button',
    text: label,
    onClick: (e) => {
      e.stopPropagation();
      onClick();
    },
  });
}

function showDone(row, text, undo, itemOf) {
  row.replaceChildren();
  row.className = 'np-act is-done';
  row.append(lucideIcon('check', 'btn-lucide np-act-ico'), el('span', { class: 'np-act-note', text }));
  if (!undo) return;
  let undoing = false;
  const undoBtn = linkButton(t('nowPlaying.undo'), async () => {
    if (undoing) return; // one Undo per action
    undoing = true;
    undoBtn.disabled = true;
    try {
      await undo();
      toast(t('nowPlaying.undone'), 'ok');
      if (itemOf) markTitleChanged(itemOf());
    } catch (err) {
      toast((err && err.message) || t('nowPlaying.failed'), 'bad');
      undoing = false;
      undoBtn.disabled = false;
      return;
    }
    // The snapshot on hand was read after the action and still says it was
    // counted: read Kodi and the library again before rebuilding the row from
    // it, so the row never flashes "already counted" with a second Undo.
    state = { key: null, done: null, undo: null, busy: false };
    row._sig = null;
    try {
      await refreshNowPlaying();
    } catch {
      /* the next poll brings it */
    }
    row.dispatchEvent(new CustomEvent('np-act-reset', { bubbles: true }));
  });
  row.append(undoBtn);
}
