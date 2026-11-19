import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = '/shelfit/';

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(full) : [full];
  });
}

// Stamps the built service worker (public/sw.js, copied as is into dist/):
//   __SHELFIT_BUILD_ID__   -> a hash of every built file and of the worker itself
//   [] __SHELFIT_PRECACHE__ -> every /static/* file, for the install step
// So each deploy that changes anything ships a worker with different bytes (the
// browser then installs it, with a fresh cache), and every chunk is precached for
// offline use. This replaces the manual CACHE version bump.
function shelfitServiceWorker() {
  let outDir;
  return {
    name: 'shelfit-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const swFile = path.join(outDir, 'sw.js');
      const rel = (f) => path.relative(outDir, f).split(path.sep).join('/');
      const files = filesUnder(outDir).sort((a, b) => rel(a).localeCompare(rel(b)));
      const hash = createHash('sha256');
      for (const f of files) {
        hash.update(rel(f));
        hash.update(fs.readFileSync(f));
      }
      const buildId = hash.digest('hex').slice(0, 12);
      const precache = files.filter((f) => rel(f).startsWith('static/')).map((f) => BASE + rel(f));

      let sw = fs.readFileSync(swFile, 'utf8');
      const stamps = [
        ["'__SHELFIT_BUILD_ID__'", `'${buildId}'`],
        ['[] /* __SHELFIT_PRECACHE__ */', JSON.stringify(precache)],
      ];
      for (const [from, to] of stamps) {
        if (!sw.includes(from)) throw new Error(`sw.js: placeholder ${from} not found`);
        sw = sw.replace(from, to);
      }
      fs.writeFileSync(swFile, sw);
      this.info?.(`sw.js stamped: build ${buildId}, ${precache.length} precached files`);
    },
  };
}

// The build/dev commands run with `client/` as the root, so this config lives
// in client/. publicDir defaults to client/public (manifest.json, sw.js, icons).
export default defineConfig({
  // The app is served under this sub-path (see Caddyfile). Vite rewrites the
  // bundle URLs and %BASE_URL% in index.html to match; client/src/basePath.js
  // reads it back via import.meta.env.BASE_URL as the single source of truth.
  base: BASE,
  plugins: [shelfitServiceWorker()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Emit bundled JS/CSS under /static/ so they don't collide with the
    // backend's /assets/* route (which serves cached TMDB images).
    assetsDir: 'static',
  },
  server: {
    port: 5173,
    // Proxy backend calls to Fastify during development.
    proxy: {
      '/api': 'http://localhost:3000',
      '/assets': 'http://localhost:3000',
      '/badges': 'http://localhost:3000',
    },
  },
});
