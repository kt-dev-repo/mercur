#!/bin/sh
# Entrypoint for the Mercur backend image.
#
#   entrypoint.sh server   -> runs migrations (unless RUN_MIGRATIONS=false), then serves HTTP
#                             + background jobs. This is the default.
#   entrypoint.sh worker   -> skips migrations, runs background jobs only.
#   entrypoint.sh migrate  -> runs migrations and exits.
#   entrypoint.sh seed     -> runs the demo seed and exits. A no-op on a seeded database.
#   entrypoint.sh <cmd...> -> runs an arbitrary command (e.g. `npx medusa user -e ... -p ...`).
set -e

ROLE="${1:-server}"

# A password containing "/", "+" or "=" — exactly what `openssl rand -base64` emits —
# is not URL-safe, and docker-compose.yml interpolates POSTGRES_PASSWORD into
# DATABASE_URL raw. A "/" either makes the URL unparseable or silently reinterprets
# the host, and the only symptom is a connection that never succeeds. Say so instead.
check_database_url() {
  [ -n "$DATABASE_URL" ] || return 0
  # Two failure shapes, both from an unescaped "/" in the password: one throws on
  # parse, the other parses "wrong" — postgres://mercur:/pw@host/db reads the host
  # as "mercur" and swallows the rest into the path. Hence the shape check as well.
  node -e "
const u = new URL(process.env.DATABASE_URL);
const ok = /^postgres(ql)?:\$/.test(u.protocol) && u.hostname && /^\/[^/]+\$/.test(u.pathname);
process.exit(ok ? 0 : 1);
" 2>/dev/null && return 0
  echo "[entrypoint] refusing to start: DATABASE_URL is not a usable postgres URL." >&2
  echo "[entrypoint] The usual cause is an unescaped character in the password —" >&2
  echo "[entrypoint] '/', '+' and '=' must be percent-encoded (%2F, %2B, %3D)." >&2
  echo "[entrypoint] Generate a URL-safe password instead: openssl rand -hex 32" >&2
  exit 1
}

wait_for_postgres() {
  [ -n "$DATABASE_URL" ] || return 0
  # `pg` ships transitively with the Medusa runtime; if it is not resolvable we
  # skip the readiness probe rather than blocking startup on a missing module.
  node -e "require('pg')" 2>/dev/null || { echo "[entrypoint] pg not resolvable — skipping readiness probe."; return 0; }
  echo "[entrypoint] waiting for Postgres..."
  i=0
  until node -e "
const { Client } = require('pg');
// SSL is decided by sslmode in DATABASE_URL, so the connection string is the single source of truth.
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "[entrypoint] Postgres did not become reachable in time" >&2
      exit 1
    fi
    sleep 2
  done
  echo "[entrypoint] Postgres is up."
}

# medusa-config.ts falls back to the literal "supersecret" when these are unset, so a
# deploy that forgets them comes up looking healthy while signing every session token
# with a value published in this repository. The check lives here rather than in the
# config because `medusa build` loads that config at image-build time, when the runtime
# secrets legitimately do not exist yet. docker-compose.yml also guards them with `:?`;
# this covers every other way the image gets run.
require_secrets() {
  missing=""
  [ -n "$JWT_SECRET" ] || missing="$missing JWT_SECRET"
  [ -n "$COOKIE_SECRET" ] || missing="$missing COOKIE_SECRET"
  if [ -n "$missing" ]; then
    echo "[entrypoint] refusing to start: missing required secret(s):$missing" >&2
    echo "[entrypoint] generate each separately with: openssl rand -base64 48" >&2
    exit 1
  fi
}

run_migrations() {
  echo "[entrypoint] running database migrations..."
  npx medusa db:migrate
}

case "$ROLE" in
  server)
    require_secrets
    check_database_url
    wait_for_postgres
    if [ "$RUN_MIGRATIONS" != "false" ]; then
      run_migrations
    else
      echo "[entrypoint] RUN_MIGRATIONS=false — skipping migrations."
    fi
    # No marker file. This used to be /app/static/.mercur-seeded on the uploads
    # volume — a flag for the state of a *different* volume, which broke both ways:
    # losing the database but keeping uploads left the marketplace permanently empty
    # behind a green healthcheck, and losing uploads but keeping the database re-ran
    # the seed over live data. The seed script now decides for itself by looking at
    # the database, so the answer can never disagree with the data.
    if [ "$RUN_SEED" = "true" ]; then
      echo "[entrypoint] seeding demo data (a no-op if this marketplace is already seeded)..."
      if npx medusa exec ./src/scripts/seed.js; then
        echo "[entrypoint] seed step finished."
      else
        # Demo data is optional; the marketplace is not. Exiting here would restart
        # the container, retry the same failing seed and exit again — an unreachable
        # site instead of a running one missing its demo catalog.
        echo "[entrypoint] WARNING: seeding failed. Starting the server anyway." >&2
        echo "[entrypoint] Re-run it later with: npx medusa exec ./src/scripts/seed.js" >&2
      fi
    fi
    export MEDUSA_WORKER_MODE="${MEDUSA_WORKER_MODE:-shared}"
    echo "[entrypoint] starting Medusa (worker mode: $MEDUSA_WORKER_MODE)"
    exec npx medusa start
    ;;

  worker)
    require_secrets
    check_database_url
    wait_for_postgres
    export MEDUSA_WORKER_MODE=worker
    echo "[entrypoint] starting Medusa worker"
    exec npx medusa start
    ;;

  migrate)
    check_database_url
    wait_for_postgres
    run_migrations
    ;;

  seed)
    check_database_url
    wait_for_postgres
    exec npx medusa exec ./src/scripts/seed.js
    ;;

  *)
    exec "$@"
    ;;
esac
