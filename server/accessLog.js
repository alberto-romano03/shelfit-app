// Minimal authentication access log.
//
// Records login / magic-link / sign-out-all events with only HASHED identifiers
// (never a raw IP or user-agent) so the owner can spot suspicious activity while
// no personal data is retained. Writes are fire-and-forget — never awaited in a
// request handler and never allowed to throw into one, so logging can't slow or
// break authentication. Entries older than 90 days are pruned on boot and daily.

import db from './db.js';
import { clientIp, hashValue } from './security.js';

// Event type constants (kept short; stored verbatim in the `event` column).
export const EVENTS = {
  LOGIN: 'login',
  MAGIC_LINK: 'magic_link',
  LOGOUT_ALL: 'logout_all',
  INVITE: 'invite', // a member set their password from an invite
};

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// --- Prepared statements (compiled once at module load, reused thereafter) ---
const insertStmt = db.prepare(
  `INSERT INTO access_log (event, ip_hash, user_agent_hash, success, created_at, user_id)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const recentStmt = db.prepare(
  `SELECT a.event, a.success, a.created_at, u.display_name
     FROM access_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC
    LIMIT ?`
);
const pruneStmt = db.prepare('DELETE FROM access_log WHERE created_at < ?');

// Record one event, attributed to the account it targeted (null when unknown).
// Best-effort: any failure is swallowed so a logging hiccup
// can never turn a successful (or failed) login into a 500. Not async — the
// underlying insert is synchronous and sub-millisecond — but callers MUST NOT
// await/return it, treating it as fire-and-forget.
export function logAccess(event, request, success, userId = null) {
  try {
    insertStmt.run(
      String(event),
      hashValue(clientIp(request)),
      hashValue((request && request.headers && request.headers['user-agent']) || ''),
      success ? 1 : 0,
      Date.now(),
      userId
    );
  } catch {
    /* logging must never break the request path */
  }
}

// The last `limit` events, newest first — for the read-only "Recent access"
// panel in Settings. Never exposes the hashes themselves.
export function getRecentAccess(limit = 20) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  try {
    return recentStmt.all(n).map((r) => ({
      event: r.event,
      success: !!r.success,
      created_at: r.created_at,
      user: r.display_name || null, // the account it targeted, when known
    }));
  } catch {
    return [];
  }
}

// Delete entries older than the retention window. Returns the number removed.
export function pruneAccessLog() {
  try {
    return pruneStmt.run(Date.now() - RETENTION_MS).changes;
  } catch {
    return 0;
  }
}

// Prune now (boot) and once daily thereafter. The interval is unref'd so it
// never keeps the process alive on its own.
const DAY_MS = 24 * 60 * 60 * 1000;
export function startAccessLogCleanup(logger) {
  const sweep = () => {
    const n = pruneAccessLog();
    if (n && logger) logger.info(`access-log: pruned ${n} entr${n === 1 ? 'y' : 'ies'} older than 90 days`);
  };
  sweep();
  const timer = setInterval(sweep, DAY_MS);
  if (timer.unref) timer.unref();
  return timer;
}
