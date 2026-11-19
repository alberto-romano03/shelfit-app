#!/bin/sh
# Runs the app as the unprivileged `node` user.
#
# Started as root (the default): first hand the data folder to `node`, since
# images before this one ran as root and left root-owned files there that `node`
# could not write (only files not already owned by `node` are touched, so later
# starts are quick), then drop to `node` for good. Started as another user
# already: just run.
set -e
if [ "$(id -u)" = "0" ]; then
  find /app/data ! -user node -exec chown node:node {} + 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
