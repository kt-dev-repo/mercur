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
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
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

run_migrations() {
  echo "[entrypoint] running database migrations..."
  npx medusa db:migrate
}

case "$ROLE" in
  server)
    wait_for_postgres
    if [ "$RUN_MIGRATIONS" != "false" ]; then
      run_migrations
    else
      echo "[entrypoint] RUN_MIGRATIONS=false — skipping migrations."
    fi
    if [ "$RUN_SEED" = "true" ]; then
      echo "[entrypoint] seeding demo data..."
      npx medusa exec ./src/scripts/seed.js
    fi
    export MEDUSA_WORKER_MODE="${MEDUSA_WORKER_MODE:-shared}"
    echo "[entrypoint] starting Medusa (worker mode: $MEDUSA_WORKER_MODE)"
    exec npx medusa start
    ;;

  worker)
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
