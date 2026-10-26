// Household management under /api/household, master only (enforced by the auth
// gate, see MASTER_ONLY in auth.js): list members, add one, rename, disable or
// re-enable, reset a password by issuing a new invite, export a member's library
// and remove a member with everything they own.
//
// The master manages accounts, never their contents: no route here reads a
// member's library except the backup export, offered right before removal so
// nothing is lost by accident. Passwords are always chosen by the member, through
// a one-time invite link (see invites.js); the master only ever sees that link.

import fs from 'node:fs';
import db from '../db.js';
import { clearItemCache } from '../cache.js';
import { getUser, isPickable, avatarFile, avatarDir, fileVersion } from '../users.js';
import { createInvite, pendingInvite, clearInvites } from '../invites.js';
import { revokeAllSessions, publicAppUrl } from '../auth.js';
import { buildExportXml } from './library.js';
import { removeSubscription } from '../push.js';
import { scheduleStatsRecompute } from '../stats.js';

const NAME_MAX = 40;

// Prepared once at module load (better-sqlite3 compiles on prepare).
const membersStmt = db.prepare(
  "SELECT * FROM users ORDER BY (role = 'master') DESC, sort_order, id"
);
const insertMemberStmt = db.prepare(
  "INSERT INTO users (role, display_name, created_at) VALUES ('member', ?, ?)"
);
const renameStmt = db.prepare('UPDATE users SET display_name = ? WHERE id = ?');
const setDisabledStmt = db.prepare('UPDATE users SET disabled = ? WHERE id = ?');
const clearPasswordStmt = db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?');
const deleteMagicLinksStmt = db.prepare('DELETE FROM magic_links WHERE user_id = ?');
const deleteUserStmt = db.prepare("DELETE FROM users WHERE id = ? AND role != 'master'");
const memberTitlesStmt = db.prepare('SELECT DISTINCT type, tmdb_id FROM items WHERE user_id = ?');
const titleHeldStmt = db.prepare('SELECT 1 FROM items WHERE type = ? AND tmdb_id = ? LIMIT 1');

function cleanName(v) {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return name && name.length <= NAME_MAX ? name : null;
}

function memberView(u) {
  const f = isPickable(u) ? avatarFile(u) : null;
  return {
    id: u.id,
    display_name: u.display_name,
    role: u.role,
    disabled: !!u.disabled,
    has_password: !!u.password_hash,
    invite_expires_at: u.password_hash ? null : pendingInvite(u.id),
    avatar_url: f ? `/api/auth/profiles/${u.id}/avatar?v=${fileVersion(f)}` : null,
    created_at: u.created_at,
    last_login_at: u.last_login_at || null,
  };
}

function inviteResponse(request, user) {
  const invite = createInvite(user.id);
  return {
    member: memberView(getUser(user.id)),
    invite_url: publicAppUrl(request, `/login?invite=${invite.token}`), // shown once
    invite_expires_at: invite.expires_at,
  };
}

export default async function householdRoutes(fastify) {
  // GET /api/household/members
  fastify.get('/api/household/members', async () => ({
    members: membersStmt.all().map(memberView),
  }));

  // POST /api/household/members { display_name } → the new member and their
  // invite link (returned once).
  fastify.post('/api/household/members', async (request, reply) => {
    const name = cleanName((request.body || {}).display_name);
    if (!name) {
      reply.code(400);
      return { error: `display_name is required (max ${NAME_MAX} characters)` };
    }
    const id = Number(insertMemberStmt.run(name, Date.now()).lastInsertRowid);
    reply.code(201);
    return inviteResponse(request, getUser(id));
  });

  // PATCH /api/household/members/:id { display_name?, disabled? }
  fastify.patch('/api/household/members/:id', async (request, reply) => {
    const user = getUser(request.params.id);
    if (!user) {
      reply.code(404);
      return { error: 'not found' };
    }
    const body = request.body || {};
    if (body.display_name !== undefined) {
      const name = cleanName(body.display_name);
      if (!name) {
        reply.code(400);
        return { error: `display_name is required (max ${NAME_MAX} characters)` };
      }
      renameStmt.run(name, user.id);
    }
    if (body.disabled !== undefined) {
      if (user.role === 'master') {
        reply.code(400);
        return { error: 'the master account cannot be disabled' };
      }
      setDisabledStmt.run(body.disabled ? 1 : 0, user.id);
      if (body.disabled) {
        revokeAllSessions(user.id); // signed out everywhere, now
        removeSubscription(user.id); // and no more notifications on their devices
      }
    }
    return { member: memberView(getUser(user.id)) };
  });

  // POST /api/household/members/:id/invite → reset: the member's password,
  // sessions, magic links and push devices stop working, and a new invite lets them choose a
  // new password. The master's own password is reset from .env instead.
  fastify.post('/api/household/members/:id/invite', async (request, reply) => {
    const user = getUser(request.params.id);
    if (!user) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (user.role === 'master') {
      reply.code(400);
      return { error: 'reset the master password with APP_PASSWORD_RESET' };
    }
    db.transaction(() => {
      clearPasswordStmt.run(user.id);
      deleteMagicLinksStmt.run(user.id);
      revokeAllSessions(user.id);
      removeSubscription(user.id);
    })();
    return inviteResponse(request, user);
  });

  // GET /api/household/members/:id/export → that member's library backup (the
  // same XML as their own Settings > Backup), offered before removing them.
  fastify.get('/api/household/members/:id/export', async (request, reply) => {
    const user = getUser(request.params.id);
    if (!user) {
      reply.code(404);
      return { error: 'not found' };
    }
    const date = new Date().toISOString().slice(0, 10);
    const slug = user.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `member-${user.id}`;
    reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="shelfit_library-${slug}-${date}.xml"`)
      .header('Cache-Control', 'no-store');
    return buildExportXml(user.id);
  });

  // DELETE /api/household/members/:id → remove a member and everything they own
  // (library, progress, lists, Wall, sessions, links, invites: all cascade).
  // Cached titles nobody else has are reclaimed, as when deleting a title.
  fastify.delete('/api/household/members/:id', async (request, reply) => {
    const user = getUser(request.params.id);
    if (!user) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (user.role === 'master') {
      reply.code(400);
      return { error: 'the master account cannot be removed' };
    }
    const titles = memberTitlesStmt.all(user.id);
    db.transaction(() => {
      clearInvites(user.id);
      deleteUserStmt.run(user.id); // push subscriptions cascade with the rest
    })();
    scheduleStatsRecompute(db);
    try {
      fs.rmSync(avatarDir(user.id), { recursive: true, force: true });
    } catch (err) {
      fastify.log.warn(`could not remove avatar folder of user ${user.id}: ${err.message}`);
    }
    for (const t of titles) {
      if (titleHeldStmt.get(t.type, t.tmdb_id)) continue;
      try {
        clearItemCache(t.type, t.tmdb_id);
      } catch (err) {
        fastify.log.warn(`cache cleanup failed for ${t.type} ${t.tmdb_id}: ${err.message}`);
      }
    }
    return { ok: true };
  });
}
