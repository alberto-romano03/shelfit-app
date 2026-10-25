// Builds a real shelfIt app on a throwaway data directory and drives it with
// fastify.inject(): no port, no network, no contact with the real data/ folder.
//
// The server reads its config (data dir, API keys, password) when its modules are
// first imported, so everything is set in process.env BEFORE the dynamic imports
// below. node --test runs each test file in its own process, so every file gets a
// fresh app and database.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_PASSWORD = 'test-password-123';

export async function startApp({ password = TEST_PASSWORD } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfit-test-'));
  process.env.SHELFIT_DATA_DIR = dataDir;
  process.env.NODE_ENV = 'test';
  // No API keys: any code path that would reach TMDB or Fanart.tv fails fast
  // instead of making a request, so tests only ever use the cached fixtures.
  process.env.TMDB_API_KEY = '';
  process.env.FANART_API_KEY = '';
  delete process.env.APP_PASSWORD_RESET;
  if (password) process.env.APP_PASSWORD = password;
  else delete process.env.APP_PASSWORD;

  const { default: db } = await import('../../server/db.js');
  // Pin the metadata language before any title exists, so fixture metadata (stamped
  // en-US) is never treated as stale and refetched.
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('tmdb_language', 'en-US')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run();

  const { buildApp } = await import('../../server/app.js');
  const app = await buildApp({ quiet: true });
  await app.ready();

  return {
    app,
    db,
    dataDir,
    async close() {
      await app.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Sign in and return the Cookie header value for later requests.
export async function login(app, password = TEST_PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const setCookie = [].concat(res.headers['set-cookie'] || [])[0] || '';
  return setCookie.split(';')[0];
}

// Thin JSON client bound to one session cookie.
export function client(app, cookie) {
  async function call(method, url, payload, headers = {}) {
    const res = await app.inject({
      method,
      url,
      payload,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    });
    let json = null;
    try {
      json = res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.statusCode, json, body: res.body, headers: res.headers };
  }
  return {
    get: (url) => call('GET', url),
    post: (url, payload, headers) => call('POST', url, payload, headers),
    patch: (url, payload) => call('PATCH', url, payload),
    del: (url) => call('DELETE', url),
  };
}

// Poll `fn` until it returns a truthy value (for the debounced stats recompute).
export async function waitFor(fn, { timeoutMs = 3000, stepMs = 50 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
