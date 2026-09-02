#!/bin/sh
# Entrypoint for the Mercur backend image.
#
#   entrypoint.sh server   -> runs migrations (unless RUN_MIGRATIONS=false), then serves HTTP
#                             + background jobs. This is the default.
#   entrypoint.sh worker   -> skips migrations, runs background jobs only.
#   entrypoint.sh migrate  -> runs migrations and exits.
#   entrypoint.sh seed     -> runs the demo seed and exits.
#   entrypoint.sh <cmd...> -> runs an arbitrary command (e.g. `npx medusa user -e ... -p ...`).
set -e

ROLE="${1:-server}"

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
    wait_for_postgres
    if [ "$RUN_MIGRATIONS" != "false" ]; then
      run_migrations
    else
      echo "[entrypoint] RUN_MIGRATIONS=false — skipping migrations."
    fi
    # The marker lives on the uploads volume so it survives restarts and redeploys.
    # Without it, leaving RUN_SEED=true would re-seed on every single restart.
    SEED_MARKER=/app/static/.mercur-seeded
    if [ "$RUN_SEED" = "true" ] && [ ! -f "$SEED_MARKER" ]; then
      echo "[entrypoint] seeding demo data..."
      npx medusa exec ./src/scripts/seed.js
      touch "$SEED_MARKER"
      echo "[entrypoint] seed complete; marked at $SEED_MARKER."
    elif [ "$RUN_SEED" = "true" ]; then
      echo "[entrypoint] RUN_SEED=true but $SEED_MARKER exists — already seeded, skipping."
    fi
    export MEDUSA_WORKER_MODE="${MEDUSA_WORKER_MODE:-shared}"
    echo "[entrypoint] starting Medusa (worker mode: $MEDUSA_WORKER_MODE)"
    exec npx medusa start
    ;;

  worker)
    require_secrets
    wait_for_postgres
    export MEDUSA_WORKER_MODE=worker
    echo "[entrypoint] starting Medusa worker"
    exec npx medusa start
    ;;

  migrate)
    wait_for_postgres
    run_migrations
    ;;

  seed)
    wait_for_postgres
    exec npx medusa exec ./src/scripts/seed.js
    ;;

  *)
    exec "$@"
    ;;
esac
