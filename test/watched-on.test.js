// A title with no explicit watch_date uses updated_at as its "watched on" date, on
// the detail page, in the monthly receipt and in the library export. So only a real
// status change may move it: rating or annotating an old film must not drop it into
// this month's receipt.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, TEST_PASSWORD } from './helpers/harness.js';

const WATCHED = '2024-03-15 10:00:00';
const TITLE = 'Watched Long Ago';

describe('the watched-on date', () => {
  let h;
  let api;
  let id;

  const updatedAt = () => h.db.prepare('SELECT updated_at FROM items WHERE id = ?').get(id).updated_at;
  const onReceipt = async (month) => {
    const url = month ? `/api/receipt?month=${month}` : '/api/receipt';
    const res = await api.get(url);
    assert.equal(res.status, 200);
    return res.body.includes(TITLE);
  };

  before(async () => {
    h = await startApp();
    api = client(h.app, await login(h.app, TEST_PASSWORD));
    const master = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get();
    id = h.db
      .prepare(
        `INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status, updated_at)
         VALUES (?, '999001', 'movie', ?, ?, 'completed', ?)`
      )
      .run(master.id, TITLE, TITLE, WATCHED).lastInsertRowid;
  });
  after(async () => {
    if (h) await h.close();
  });
  beforeEach(() => {
    h.db.prepare("UPDATE items SET status = 'completed', updated_at = ? WHERE id = ?").run(WATCHED, id);
  });

  it('stays put when the title is rated, or its rating is cleared', async () => {
    assert.equal((await api.patch(`/api/media/${id}`, { rating: 5 })).status, 200);
    assert.equal(updatedAt(), WATCHED);
    assert.equal((await api.patch(`/api/media/${id}`, { rating: null })).status, 200);
    assert.equal(updatedAt(), WATCHED);
  });

  it('stays put for notes, a favourite or the owned flag', async () => {
    assert.equal((await api.patch(`/api/media/${id}`, { notes: 'Still great' })).status, 200);
    assert.equal((await api.patch(`/api/media/${id}`, { favorite: true })).status, 200);
    assert.equal((await api.patch(`/api/media/${id}`, { owned: true })).status, 200);
    assert.equal(updatedAt(), WATCHED);
  });

  it('stays put when the same status is sent again', async () => {
    assert.equal((await api.patch(`/api/media/${id}`, { status: 'completed' })).status, 200);
    assert.equal(updatedAt(), WATCHED);
  });

  it('moves when the status really changes', async () => {
    assert.equal((await api.patch(`/api/media/${id}`, { status: 'paused' })).status, 200);
    assert.notEqual(updatedAt(), WATCHED);
  });

  it('keeps a rated title in the receipt of the month it was watched', async () => {
    assert.equal((await api.patch(`/api/media/${id}`, { rating: 4 })).status, 200);
    assert.equal(await onReceipt('2024-03'), true);
    assert.equal(await onReceipt(), false);
  });
});
