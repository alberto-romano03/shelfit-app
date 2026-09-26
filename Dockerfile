# syntax=docker/dockerfile:1

# ---- Build stage: compile native deps + build the client ----------------
FROM node:22-alpine AS build
WORKDIR /app

# Build tools needed to compile better-sqlite3 (native addon).
RUN apk add --no-cache python3 make g++

# Install all dependencies (incl. dev: vite/esbuild for the client build).
# No lockfile required — npm resolves the ranges in package.json.
COPY package.json ./
RUN npm install

# Build the client (Vite) into /app/client/dist.
COPY client/ ./client/
RUN npm run build

# Drop dev dependencies but keep the already-compiled better-sqlite3 binary.
RUN npm prune --omit=dev

# ---- Runtime stage: slim image, no build tools --------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# cwebp (libwebp-tools) compresses cached Fanart disc art to WebP. Small,
# runtime-only system tool — not an npm dependency.
RUN apk add --no-cache libwebp-tools

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/client/dist ./client/dist
COPY package.json ./
COPY server/ ./server/

EXPOSE 3000
CMD ["node", "server/index.js"]
