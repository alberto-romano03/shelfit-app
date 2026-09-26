import { defineConfig } from 'vite';

// The build/dev commands run with `client/` as the root, so this config lives
// in client/. publicDir defaults to client/public (manifest.json, sw.js, icons).
export default defineConfig({
  // The app is served under this sub-path (see Caddyfile). Vite rewrites the
  // bundle URLs and %BASE_URL% in index.html to match; client/src/basePath.js
  // reads it back via import.meta.env.BASE_URL as the single source of truth.
  base: '/shelfit/',
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
