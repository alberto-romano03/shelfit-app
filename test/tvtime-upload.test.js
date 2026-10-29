// The TV Time import every member can run by uploading the export's .zip, and
// the zip reader behind it.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startApp, login, client, addUser, waitFor, TEST_PASSWORD } from './helpers/harness.js';
import { readZipEntries, ZipError } from '../server/zip.js';

// A small ZIP writer (stored or deflated entries), so the tests can build the
// archives a member would upload. The reader doesn't check CRCs, so they're 0.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const data = f.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = f.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Uploads are rate-limited per IP: give each request its own.
let ipSeq = 0;
const asZip = () => ({ 'content-type': 'application/zip', 'x-forwarded-for': `10.0.0.${++ipSeq}` });

describe('TV Time import for every member', () => {
  let h;
  let master;
  let bea;
  let carl;
  let beaId;

  before(async () => {
    h = await startApp();
    const masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    beaId = await addUser(h.db, { name: 'Bea', password: 'bea-pass-1234' });
    const carlId = await addUser(h.db, { name: 'Carl', password: 'carl-pass-123' });
    master = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    bea = client(h.app, await login(h.app, 'bea-pass-1234', beaId));
    carl = client(h.app, await login(h.app, 'carl-pass-123', carlId));
  });
  after(async () => {
    if (h) await h.close();
  });

  it('keeps the server-folder import for the master only', async () => {
    assert.equal((await bea.post('/api/import/tvtime', {})).status, 403);
  });

  it('rejects a file that is not a zip, or a zip without TV Time files', async () => {
    const notZip = await bea.post('/api/tvtime/upload', Buffer.from('hello'), asZip());
    assert.equal(notZip.status, 400);
    assert.equal(notZip.json.error, 'not_a_zip');
    const other = makeZip([{ name: 'photos/readme.txt', data: 'nothing here' }]);
    const res = await bea.post('/api/tvtime/upload', other, asZip());
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'tvtime_missing');
  });

  it("imports a member's own upload, then deletes it", async () => {
    const csv = 'type,entity_type,movie_name,created_at\nwatch,movie,Unfindable Film,2026-01-01 10:00:00\n';
    const zip = makeZip([
      { name: 'tvtime-export/tracking-prod-records.csv', data: csv, deflate: true },
      { name: 'tvtime-export/unrelated.json', data: '{}' },
    ]);
    const res = await bea.post('/api/tvtime/upload', zip, asZip());
    assert.equal(res.status, 200, res.body);

    // Another member only learns that the importer is busy, nothing about it.
    const peek = (await carl.get('/api/tvtime/status')).json;
    assert.equal(peek.mine, false);
    assert.equal(peek.processed, undefined);

    const done = await waitFor(
      async () => {
        const s = (await bea.get('/api/tvtime/status')).json;
        return s.mine && !s.running && s.phase === 'done' ? s : null;
      },
      { timeoutMs: 10000 }
    );
    assert.equal(done.not_found, 1);
    assert.match((await bea.get('/api/tvtime/log')).json.log, /Unfindable Film/);
    assert.equal((await carl.get('/api/tvtime/log')).json.log, '');
    assert.equal(fs.existsSync(path.join(h.dataDir, 'import', 'uploads', `u${beaId}`)), false);
  });

  it("lets the master upload into another member's library", async () => {
    const csv = 'type,entity_type,movie_name,created_at\nwatch,movie,Another Film,2026-01-01 10:00:00\n';
    const zip = makeZip([{ name: 'tracking-prod-records.csv', data: csv }]);
    const res = await master.post(`/api/tvtime/upload?user_id=${beaId}`, zip, asZip());
    assert.equal(res.status, 200, res.body);
    await waitFor(async () => !(await master.get('/api/tvtime/status')).json.running, { timeoutMs: 10000 });
    // A member's own ?user_id= is ignored: it always fills their own library.
    const own = await carl.post(`/api/tvtime/upload?user_id=${beaId}`, zip, asZip());
    assert.equal(own.status, 200, own.body);
    await waitFor(async () => !(await carl.get('/api/tvtime/status')).json.running, { timeoutMs: 10000 });
    assert.equal((await bea.get('/api/tvtime/status')).json.mine, false, 'the last upload was Carl\'s');
  });
});

describe('zip reader', () => {
  it('reads stored and deflated entries by file name, ignoring folders and other files', () => {
    const zip = makeZip([
      { name: 'a/b/one.csv', data: 'x,y\n1,2\n' },
      { name: 'two.csv', data: 'z\n3\n', deflate: true },
      { name: 'skip.txt', data: 'no' },
    ]);
    const out = readZipEntries(zip, ['one.csv', 'TWO.csv']);
    assert.deepEqual([...out.keys()].sort(), ['one.csv', 'two.csv']);
    assert.equal(out.get('two.csv').toString(), 'z\n3\n');
  });

  it('refuses non-zips and entries over the size cap', () => {
    assert.throws(() => readZipEntries(Buffer.from('not a zip at all, sorry'), ['a.csv']), ZipError);
    const big = makeZip([{ name: 'big.csv', data: 'a'.repeat(5000), deflate: true }]);
    assert.throws(() => readZipEntries(big, ['big.csv'], { maxEntryBytes: 1000 }), ZipError);
  });
});
