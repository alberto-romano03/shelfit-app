// The backup parser is linear in the file size. The regex scan it replaced
// (/<movie ...>([\s\S]*?)<\/movie>/g) rescanned to the end of the text from every
// opening tag that never closed: a few MB of `<movie tmdb_id="1">` blocked the
// event loop for minutes, for every member at once.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, login, client, addUser } from './helpers/harness.js';

let ipSeq = 0;
const asXml = () => ({ 'content-type': 'application/xml', 'x-forwarded-for': `10.0.2.${++ipSeq}` });
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// A file whose checksum is right, so parsing really runs on `content`.
function backup(content, count = 0) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<shelfit_library>\n  <meta>\n` +
    `    <version>5</version>\n    <checksum>${sha256(content)}</checksum>\n` +
    `    <entry_count>${count}</entry_count>\n  </meta>\n` +
    `  <library>${content}</library>\n</shelfit_library>\n`
  );
}

describe('backup parser', () => {
  let h;
  let member;

  before(async () => {
    h = await startApp();
    const id = await addUser(h.db, { name: 'Anna', password: 'anna-pass-123' });
    member = client(h.app, await login(h.app, 'anna-pass-123', id));
  });
  after(async () => {
    if (h) await h.close();
  });

  const fill = (unit) => unit.repeat(Math.floor((4 * 1024 * 1024) / unit.length));
  for (const [what, content] of [
    ['opening tags that never close', fill('<movie tmdb_id="1">')],
    ['shows and seasons that never close', fill('<show tmdb_id="1"><season number="1">')],
    // Inside a closed entry, so the inner scans run too (declared count is off by
    // one, so the file is still refused after parsing).
    ['list names that never close', `<movie tmdb_id="1"><lists>${fill('<list>')}</lists></movie>`],
    ['episodes inside a closed show', `<show tmdb_id="1"><season number="1">${fill('<episode ')}</season></show>`],
  ]) {
    it(`parses a file of ${what} quickly`, async () => {
      const started = Date.now();
      const res = await member.post('/api/library/import', backup(`\n${content}  `, 2), asXml());
      const ms = Date.now() - started;
      assert.equal(res.status, 400, res.body);
      assert.ok(ms < 3000, `took ${ms} ms`);
    });
  }

  it('still reads a well-formed file', async () => {
    const content =
      '\n    <movie tmdb_id="603">\n      <title>The Matrix</title>\n      <status>watched</status>\n' +
      '      <rating>5</rating>\n      <lists>\n        <list>Faves &amp; more</list>\n      </lists>\n' +
      '      <rewatches>\n        <rewatch date="2024-02-03"/>\n      </rewatches>\n    </movie>\n' +
      '    <show tmdb_id="1396">\n      <title>Breaking Bad</title>\n      <status>watching</status>\n' +
      '      <seasons>\n        <season number="1">\n          <episode number="1" play_count="2"/>\n' +
      '          <episode number="2" watched="false" stopped_at="12"/>\n        </season>\n      </seasons>\n    </show>\n  ';
    const { validateImport } = await import('../server/routes/library.js');
    const v = validateImport(backup(content, 2));
    assert.equal(v.ok, true, v.error);
    const [movie, show] = v.entries;
    assert.equal(movie.tmdb_id, '603');
    assert.equal(movie.title, 'The Matrix');
    assert.equal(movie.rating, 5);
    assert.deepEqual(movie.lists, ['Faves & more']);
    assert.deepEqual(movie.rewatches, ['2024-02-03']);
    assert.equal(show.tmdb_id, '1396');
    assert.deepEqual(show.episodes.map((e) => [e.season, e.episode, e.play_count]), [[1, 1, 2]]);
    assert.deepEqual(show.stops.map((s) => [s.episode, s.minute, s.unwatched]), [[2, 12, true]]);
  });
});
