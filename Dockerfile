# syntax=docker/dockerfile:1

# ---- Build stage: compile native deps + build the client ----------------
FROM node:22-alpine AS build
WORKDIR /app

# Build tools needed to compile better-sqlite3 (native addon).
RUN apk add --no-cache python3 make g++

# Install all dependencies (incl. dev: vite/esbuild for the client build),
# exactly as package-lock.json pins them, so every build gets the same versions.
COPY package.json package-lock.json ./
RUN npm ci

# Build the client (Vite) into /app/client/dist.
COPY client/ ./client/
RUN npm run build

# Drop dev dependencies but keep the already-compiled better-sqlite3 binary.
RUN npm prune --omit=dev

# ---- Test stage: server test suite, never part of the runtime image ---------
# docker build --target test -t shelfit-test . && docker run --rm shelfit-test
# (node:test is built in, so the pruned dependencies are all it needs.)
FROM build AS test
COPY server/ ./server/
COPY test/ ./test/
CMD ["node", "--test", "test/**/*.test.js"]

# ---- Runtime stage: slim image, no build tools --------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# cwebp (libwebp-tools) compresses cached Fanart disc art to WebP. Small,
# runtime-only system tool, not an npm dependency. su-exec drops from root to
# `node` in the entrypoint.
RUN apk add --no-cache libwebp-tools su-exec

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/client/dist ./client/dist
COPY package.json ./
COPY server/ ./server/

# Not root: the app runs as the image's own `node` user, which owns only the
# data folder (the volume mounted there keeps the database, caches and keys);
# the code stays root-owned and read-only to it. The entrypoint starts as root
# just long enough to hand over files older images (which ran as root) left in
# the volume, then drops to `node` (docker-entrypoint.sh). Line endings are
# normalised in case a Windows checkout gave the script CRLF.
RUN mkdir -p /app/data && chown node:node /app/data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod 755 /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]

EXPOSE 3000
# Liveness for Docker (and `docker ps`): the same probe the clients poll.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/index.js"]
