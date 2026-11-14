// A way back after a serious action, on top of its confirmation. Two kinds, chosen by what
// the server can do:
//
//   undoable(): the action has already happened and can truly be reversed. The toast's
//   Undo runs the reverse.
//
//   deferred(): the action is a permanent delete, so nothing is sent yet. The title or
//   list is hidden, and the delete goes out when the toast ends. It also goes out when
//   the app is put away, or on leaving the page the toast was shown on, since other pages
//   would still list what is about to go.
//
// These always use the app-wide api: a page's own client is aborted as soon as you leave
// that page, which would quietly cancel the delete.

import { undoToast, toast } from './ui.js';
import { api } from './api.js';
import { t } from './i18n.js';

export function undoable({ msg, undo }) {
  undoToast({
    msg,
    onUndo: async () => {
      try {
        await undo(api);
        toast(t('toast.undone'), 'info');
      } catch (err) {
        toast((err && err.message) || t('search.somethingWrong'), 'bad');
      }
    },
  });
}

// After marking many episodes: only those this action marked go back, never the ones
// already watched. Nothing new marked means nothing to undo, so a plain toast.
export function markedToast(res, msg, { id, prompt, reload } = {}) {
  const episodes = res && res.marked_episodes;
  if (!Array.isArray(episodes) || !episodes.length) {
    toast(msg, 'ok');
    return;
  }
  undoable({
    msg,
    undo: async (a) => {
      if (prompt) prompt.close(); // "Move it to the shelf?" no longer applies
      // Marks that moved a series off the list put it back there too.
      await a.undoMarks(
        id,
        episodes,
        res.previous_current_season ?? null,
        res.status_changed ? 'plan_to_watch' : undefined
      );
      if (reload) reload();
    },
  });
}

let pending = null;
const hideRules = document.createElement('style');
document.head.append(hideRules);

function hide(selector, rule) {
  if (!selector) return () => {};
  const css = `${selector}{${rule} !important}\n`;
  hideRules.append(css);
  const node = hideRules.lastChild;
  return () => node.remove();
}

//   msg      the toast
//   run      (api) => the real delete
//   selector, rule   hides what is being deleted, wherever it is drawn. It stays hidden
//                    after the delete: that id is gone for good.
//   stayOn   the page the toast belongs to
//   onUndo, onFailed   put the page back
export function deferred({ msg, run, selector, rule = 'display:none', stayOn, onUndo, onFailed }) {
  settleDeferred();
  const show = hide(selector, rule);
  const entry = { stayOn };
  pending = entry;
  entry.toast = undoToast({
    msg,
    onUndo: () => {
      pending = null;
      show();
      if (onUndo) onUndo();
      toast(t('toast.undone'), 'info');
    },
    onExpire: async () => {
      pending = null;
      try {
        await run(api);
      } catch (err) {
        show();
        if (onFailed) onFailed();
        toast((err && err.message) || t('search.somethingWrong'), 'bad');
      }
    },
  });
}

// The window ends now: the delete goes out.
export function settleDeferred() {
  if (pending) pending.toast.finish();
}

// Called by the router's onChange.
export function settleDeferredOnRoute(path) {
  if (pending && pending.stayOn && pending.stayOn !== path) settleDeferred();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') settleDeferred();
});
window.addEventListener('pagehide', settleDeferred);
