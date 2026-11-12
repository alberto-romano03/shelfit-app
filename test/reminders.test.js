// Occasional reminders (server/reminders.js): the decisions behind a series left
// behind, a listed movie in cinemas and a finished series coming back, their
// words in both languages, and the member's switches and device language.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';

const DAY = 24 * 60 * 60 * 1000;
const ENDPOINT = 'https://push.example.test/device-1';
const SUB = { endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } };

describe('reminders', () => {
  let h;
  let a;
  let r; // server/reminders.js, loaded after the app sets its environment

  before(async () => {
    h = await startApp();
    r = await import('../server/reminders.js');
    const masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    a = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
  });
  after(async () => {
    if (h) await h.close();
  });

  it('proposes the episode after the furthest one watched, once it has aired', () => {
    const seasons = [
      { season_number: 1, episodes: [1, 2, 3].map((n) => ({ episode_number: n, air_date: '2024-01-0' + n })) },
      { season_number: 2, episodes: [{ episode_number: 1, air_date: '2024-06-01' }] },
    ];
    const watched = new Set(['1:1', '1:2', '1:3']);
    assert.deepEqual(r.nextAiredEpisode(seasons, watched, '2024-07-01'), {
      season: 2,
      episode: 1,
      air_date: '2024-06-01',
    });
    // Not out yet, or nothing watched, or caught up: nothing to propose.
    assert.equal(r.nextAiredEpisode(seasons, watched, '2024-05-01'), null);
    assert.equal(r.nextAiredEpisode(seasons, new Set(), '2024-07-01'), null);
    assert.equal(r.nextAiredEpisode(seasons, new Set([...watched, '2:1']), '2024-07-01'), null);
    // A skipped early episode is not what you were in the middle of.
    assert.equal(r.nextAiredEpisode(seasons, new Set(['1:2', '1:3']), '2024-07-01').season, 2);
  });

  it('picks one series to mention, and leaves alone the ones already reminded', () => {
    const now = Date.parse('2026-11-14T18:00:00Z');
    const sent = new Map();
    const sentOf = (id) => sent.get(id) || [];
    const c = (id, daysAgo) => ({ id, last: now - daysAgo * DAY });
    // Too recent to be left behind.
    assert.equal(r.pickDusty([c(1, 10)], sentOf, now), null);
    // The most recently watched of those left behind.
    assert.equal(r.pickDusty([c(1, 90), c(2, 40)], sentOf, now).id, 2);
    // Not twice within a month.
    sent.set(2, [now - 5 * DAY]);
    assert.equal(r.pickDusty([c(1, 90), c(2, 40)], sentOf, now).id, 1);
    // Two reminders that changed nothing: that series is let go.
    sent.set(1, [now - 40 * DAY, now - 80 * DAY]);
    assert.equal(r.pickDusty([c(1, 90)], sentOf, now), null);
    // Watching it again in between resets that.
    assert.equal(r.pickDusty([c(1, 35)], sentOf, now).id, 1);
  });

  it('reads the cinema opening of the right country', () => {
    const results = [
      { iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2026-11-07T00:00:00.000Z' }] },
      {
        iso_3166_1: 'IT',
        release_dates: [
          { type: 4, release_date: '2027-01-10T00:00:00.000Z' },
          { type: 2, release_date: '2026-11-10T00:00:00.000Z' },
          { type: 3, release_date: '2026-11-13T00:00:00.000Z' },
        ],
      },
      { iso_3166_1: 'GB', release_dates: [{ type: 2, release_date: '2026-11-20T00:00:00.000Z' }] },
    ];
    assert.equal(r.theatricalDate(results, 'IT'), '2026-11-13'); // wide over limited
    assert.equal(r.theatricalDate(results, 'GB'), '2026-11-20'); // limited when that is all
    assert.equal(r.theatricalDate(results, 'FR'), null);
  });

  it('finds the new season of a finished series in the week ahead', () => {
    const seasons = [
      { season_number: 1, air_date: '2022-01-01' },
      { season_number: 2, air_date: '2026-11-18' },
      { season_number: 3, air_date: null },
    ];
    assert.equal(r.comebackSeason(seasons, 1, '2026-11-12', '2026-11-21').season_number, 2);
    assert.equal(r.comebackSeason(seasons, 2, '2026-11-12', '2026-11-21'), null); // already seen
    assert.equal(r.comebackSeason(seasons, 1, '2026-11-01', '2026-11-10'), null); // not this week
  });

  it('words each reminder in the device language', () => {
    assert.deepEqual(r.dustyText('en', 'Severance', { season: 2, episode: 4 }, 45), {
      title: 'Remember Severance? 📺',
      body: 'S02 E04 has been waiting for you for 6 weeks.',
    });
    assert.equal(r.dustyText('it', 'Severance', { season: 2, episode: 4 }, 95).body, 'S02 E04 ti aspetta da 3 mesi.');
    const one = [{ title: 'Dune', date: '2026-11-13' }];
    assert.equal(r.cinemaText('en', one, '2026-11-12').body, 'Dune opens on Friday 13 November.');
    assert.equal(r.cinemaText('it', one, '2026-11-13').body, 'Dune è al cinema da oggi.');
    const many = ['A', 'B', 'C', 'D', 'E'].map((title) => ({ title, date: '2026-11-13' }));
    assert.equal(r.cinemaText('en', many, '2026-11-12').body, 'A, B, C and 2 more from your list are out in cinemas.');
    assert.deepEqual(r.comebackText('it', [{ title: 'Andor', season: 2, date: '2026-11-18' }], '2026-11-12'), {
      title: 'Torna Andor 🎬',
      body: 'La stagione 2 inizia mercoledì 18 novembre.',
    });
    assert.equal(
      r.comebackText('en', [{ title: 'A', season: 2, date: '2026-11-18' }, { title: 'B', season: 4, date: '2026-11-19' }], '2026-11-12').body,
      'New seasons of A and B.'
    );
  });

  it('reads progress times written by SQLite and by imports alike', () => {
    assert.equal(r.parseWatchedAt('2026-11-01 10:00:00'), Date.parse('2026-11-01T10:00:00Z'));
    assert.equal(r.parseWatchedAt('2026-11-01T10:00:00.000Z'), Date.parse('2026-11-01T10:00:00Z'));
    assert.equal(r.parseWatchedAt(null), 0);
  });

  it('keeps each member\'s reminder switches, all on until turned off', async () => {
    assert.deepEqual((await a.get('/api/push/config')).json.reminders, { dusty: true, cinema: true, comeback: true });
    const res = await a.put('/api/push/reminders', { cinema: false, bogus: false });
    assert.deepEqual(res.json.reminders, { dusty: true, cinema: false, comeback: true });
    assert.equal((await a.get('/api/push/config')).json.reminders.cinema, false);
  });

  it('keeps a device language, and only the owner can change it', async () => {
    await a.post('/api/push/subscribe', { subscription: SUB, lang: 'it' });
    const cfg = async (c) => (await c.get(`/api/push/config?endpoint=${encodeURIComponent(ENDPOINT)}`)).json;
    assert.equal((await cfg(a)).lang, 'it');
    assert.equal((await a.put('/api/push/lang', { endpoint: ENDPOINT, lang: 'en' })).status, 200);
    assert.equal((await cfg(a)).lang, 'en');
    // Re-subscribing without a language keeps the one it had.
    await a.post('/api/push/subscribe', { subscription: SUB });
    assert.equal((await cfg(a)).lang, 'en');

    const memberId = await addUser(h.db, { name: 'Giulia', password: 'member-pass-1' });
    const b = client(h.app, await login(h.app, 'member-pass-1', memberId));
    assert.equal((await b.put('/api/push/lang', { endpoint: ENDPOINT, lang: 'it' })).status, 404);
    assert.equal((await cfg(a)).lang, 'en');
  });
});
