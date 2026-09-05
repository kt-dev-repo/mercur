#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Container-level smoke test for the deploy stack.
#
# These assertions cannot be reached from jest. The production config is a
# deploy-time overlay that is compiled into the image, the backup and migration
# logic is shell and SQL, and "does a redeploy keep the data" is a question about
# volumes rather than code. Every check here corresponds to a defect that actually
# shipped and was found by running these steps by hand.
#
#   ./deploy/smoke-test.sh              build the image, then run everything
#   SKIP_BUILD=1 ./deploy/smoke-test.sh reuse the image already tagged
#   KEEP=1 ./deploy/smoke-test.sh       leave the stack up afterwards to poke at
#
# Works against Docker or Podman — it only uses the docker CLI.
# ---------------------------------------------------------------------------
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${PROJECT:-mercursmoke}"
IMAGE="${IMAGE:-mercur-backend:latest}"
BACKUP_IMAGE="${BACKUP_IMAGE:-mercur-backup:latest}"
PORT="${PORT:-9000}"
RUSTFS="${PROJECT}-rustfs"
RUSTFS_PORT="${RUSTFS_PORT:-9100}"
BASE="http://localhost:${PORT}"
RUSTFS_BASE="http://localhost:${RUSTFS_PORT}"
WORK="$(mktemp -d)"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# assert_eq <expected> <actual> <description>
assert_eq() {
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3" "expected '$1', got '$2'"; fi
}

# assert_contains <haystack> <needle> <description>
assert_contains() {
  case "$1" in
    *"$2"*) ok "$3" ;;
    *) bad "$3" "expected to find '$2'; tail of output:
$(printf '%s' "$1" | tail -c 500 | sed 's/^/        /')" ;;
  esac
}

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    printf '\nKEEP=1 — leaving %s and %s running.\n' "$PROJECT" "$RUSTFS"
    return
  fi
  printf '\nTearing down...\n'
  dc down -v >/dev/null 2>&1
  docker rm -f "$RUSTFS" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

dc() {
  docker compose --env-file "$WORK/.env" \
    -f "$REPO_ROOT/deploy/docker-compose.yml" \
    -f "$WORK/override.yml" -p "$PROJECT" "$@"
}

# Load the compiled production config inside the image with a given environment and
# report whether it was accepted. This is the cheapest possible way to exercise the
# boot guards — no database, no stack, about a second each.
config_loads() {
  docker run --rm --entrypoint node "$@" "$IMAGE" \
    -e "try{require('/app/medusa-config.js');console.log('LOADED')}catch(e){console.log('REFUSED: '+e.message.split('\n')[0])}" 2>/dev/null | tail -1
}

# Ask the compiled Resend provider whether it accepts a set of options.
#
# config_loads cannot answer this: `require`ing medusa-config.js runs the overlay's own
# guards (is the variable set?) but never reaches the provider, whose validateOptions
# Medusa calls later, during module load. A malformed RESEND_FROM therefore passes
# config_loads and then crash-loops the container at boot — which is exactly the failure
# a boot-guard suite exists to catch before a deploy does.
provider_validates() { # provider_validates <from>
  docker run --rm --entrypoint node "$IMAGE" \
    -e "const {ResendNotificationService}=require('/app/src/modules/resend/service.js');
        try{ResendNotificationService.validateOptions({api_key:'re_x',from:process.argv[1]});console.log('ACCEPTED')}
        catch(e){console.log('REFUSED: '+e.message.split('\n')[0])}" "$1" 2>/dev/null | tail -1
}

wait_for() { # wait_for <seconds> <shell-command>
  local deadline=$(( $(date +%s) + $1 )); shift
  # shellcheck disable=SC2294  # the caller passes a command string on purpose
  until eval "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 3
  done
  return 0
}

# ---------------------------------------------------------------------------

cat > "$WORK/.env" <<EOF
DOMAIN=smoke.localhost
MERCUR_BACKEND_URL=${BASE}
JWT_SECRET=smoke-jwt-secret
COOKIE_SECRET=smoke-cookie-secret
POSTGRES_PASSWORD=smokepassword
POSTGRES_USER=mercur
POSTGRES_DB=mercur
STORE_CORS=${BASE}
ADMIN_CORS=${BASE}
VENDOR_CORS=${BASE}
AUTH_CORS=${BASE}
INSECURE_COOKIES=true
RUN_MIGRATIONS=true
RUN_SEED=true
FILE_STORAGE=local
COMPOSE_PROFILES=backup
S3_ENDPOINT=http://${RUSTFS}:9000
S3_BUCKET=smoke-backups
S3_PREFIX=smoke
S3_ACCESS_KEY_ID=smokekey
S3_SECRET_ACCESS_KEY=smokesecret123
BACKUP_INTERVAL_SECONDS=3600
S3_FILE_BUCKET=smoke-media
S3_FILE_PUBLIC_URL=http://${RUSTFS}:9000/smoke-media
EOF

cat > "$WORK/override.yml" <<EOF
services:
  backend:
    ports:
      - "${PORT}:9000"
EOF

step "Building"
docker network inspect dokploy-network >/dev/null 2>&1 || docker network create dokploy-network >/dev/null
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  for img in "$IMAGE" "$BACKUP_IMAGE"; do
    docker image inspect "$img" >/dev/null 2>&1 || {
      echo "  SKIP_BUILD=1 but $img is not present — build it, or drop SKIP_BUILD." >&2
      exit 1
    }
  done
  echo "  SKIP_BUILD=1 — using $IMAGE and $BACKUP_IMAGE as tagged"
else
  dc build backend backup >"$WORK/build.log" 2>&1 || { cat "$WORK/build.log"; exit 1; }
  echo "  built $IMAGE and $BACKUP_IMAGE"
fi

# ---------------------------------------------------------------------------
step "Boot guards (no stack required)"

assert_contains "$(config_loads)" "LOADED" \
  "FILE_STORAGE unset defaults to local and loads"
assert_contains "$(config_loads -e FILE_STORAGE=local)" "LOADED" \
  "FILE_STORAGE=local loads"
assert_contains "$(config_loads -e FILE_STORAGE=nonsense)" 'must be "local" or "s3"' \
  "an unrecognised FILE_STORAGE is refused, not silently treated as local"

r=$(config_loads -e FILE_STORAGE=s3)
assert_contains "$r" "S3_FILE_BUCKET" "FILE_STORAGE=s3 with nothing else names S3_FILE_BUCKET"
assert_contains "$r" "S3_FILE_PUBLIC_URL" "...and names S3_FILE_PUBLIC_URL"
assert_contains "$r" "S3_ACCESS_KEY_ID" "...and names the missing credentials"

assert_contains "$(config_loads -e FILE_STORAGE=s3 -e S3_FILE_BUCKET=b -e S3_ACCESS_KEY_ID=k -e S3_SECRET_ACCESS_KEY=s)" \
  "S3_FILE_PUBLIC_URL" \
  "a bucket without a public URL is refused (it would store undefined/ URLs)"
assert_contains "$(config_loads -e FILE_STORAGE=s3 -e S3_FILE_BUCKET=b -e S3_FILE_PUBLIC_URL=http://x/y -e S3_ACCESS_KEY_ID=k -e S3_SECRET_ACCESS_KEY=s)" \
  "LOADED" "a fully configured s3 setup loads"

assert_contains "$(config_loads)" "LOADED" \
  "EMAIL_PROVIDER unset defaults to none and loads"
assert_contains "$(config_loads -e EMAIL_PROVIDER=local)" "LOADED" \
  "EMAIL_PROVIDER=local loads"
assert_contains "$(config_loads -e EMAIL_PROVIDER=nonsense)" 'must be "none", "local" or "resend"' \
  "an unrecognised EMAIL_PROVIDER is refused, not silently treated as none"

e=$(config_loads -e EMAIL_PROVIDER=resend)
assert_contains "$e" "RESEND_API_KEY" "EMAIL_PROVIDER=resend with nothing else names RESEND_API_KEY"
assert_contains "$e" "RESEND_FROM" "...and names RESEND_FROM"
assert_contains "$(config_loads -e EMAIL_PROVIDER=resend -e RESEND_API_KEY=re_x -e RESEND_FROM=a@b.com)" \
  "LOADED" "a fully configured resend setup loads"

# The provider's own guard, which the config guards above cannot reach.
assert_contains "$(provider_validates 'a@b.com')" "ACCEPTED" \
  "the Resend provider accepts a plain address"
assert_contains "$(provider_validates 'Our Marketplace <a@b.com>')" "ACCEPTED" \
  "...and the display-name form Resend also takes"
assert_contains "$(provider_validates 'notanemail')" "not an email address" \
  "a RESEND_FROM that is not an address is refused at module load, not on the first send"

# ---------------------------------------------------------------------------
step "First deploy"

docker rm -f "$RUSTFS" >/dev/null 2>&1
dc down -v >/dev/null 2>&1
if ! dc up -d --no-build >"$WORK/up.log" 2>&1; then
  bad "compose could not start the stack"
  tail -20 "$WORK/up.log"
  exit 1
fi

if wait_for 600 "curl -fsS ${BASE}/health"; then
  ok "backend reports healthy"
else
  bad "backend never became healthy"; dc logs backend | tail -30; exit 1
fi

psql_q() { docker exec "${PROJECT}-postgres-1" psql -U mercur -d mercur -tAc "$1" 2>/dev/null | tr -d ' '; }

assert_eq "200" "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}"/dashboard/)" "admin panel is served"
assert_eq "200" "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}"/seller/)"   "vendor panel is served"
assert_eq "3"  "$(psql_q 'select count(*) from seller;')"  "seed created 3 sellers"
assert_eq "12" "$(psql_q 'select count(*) from product;')" "seed created 12 products"

docker exec -w /app "${PROJECT}-backend-1" npx medusa user -e smoke@test.local -p 'SmokePass123!' >/dev/null 2>&1
TOKEN=$(curl -s -X POST "${BASE}/auth/user/emailpass" -H 'Content-Type: application/json' \
  -d '{"email":"smoke@test.local","password":"SmokePass123!"}' | sed 's/.*"token":"//;s/".*//')
if [ -n "$TOKEN" ]; then ok "admin user can authenticate"; else bad "admin user could not authenticate"; fi

# The defect: Medusa marks the session cookie Secure whenever NODE_ENV=production, so on
# plain http the browser stores nothing, the panel returns 200 and bounces back to login.
COOKIE_HDR=$(curl -s -i -X POST "${BASE}/auth/session" -H "Authorization: Bearer $TOKEN" | grep -ci '^set-cookie' | tr -d ' ')
assert_eq "1" "$COOKIE_HDR" "INSECURE_COOKIES=true sets a session cookie over http"

UPLOAD_URL=$(printf 'smoke' > "$WORK/f.txt"; curl -s -X POST "${BASE}/admin/uploads" \
  -H "Authorization: Bearer $TOKEN" -F "files=@$WORK/f.txt" | sed 's/.*"url":"//;s/".*//')
assert_contains "$UPLOAD_URL" "/static/" "FILE_STORAGE=local stores uploads on the volume"

# ---------------------------------------------------------------------------
step "Redeploy keeps the data"

# Rename the store and add a currency, the way an operator would, then destroy the uploads
# volume as well — the split that used to leave a marketplace silently empty.
docker exec "${PROJECT}-postgres-1" psql -U mercur -d mercur -q \
  -c "update store set name='Smoke Renamed';" >/dev/null 2>&1
dc down >/dev/null 2>&1
docker volume rm "${PROJECT}_uploads" >/dev/null 2>&1
dc up -d --no-build >/dev/null 2>&1
wait_for 600 "curl -fsS ${BASE}/health" || bad "backend did not come back after redeploy"

assert_eq "SmokeRenamed" "$(psql_q 'select name from store;')" "store name survives a redeploy"
assert_eq "3"   "$(psql_q 'select count(*) from seller;')"      "sellers survive"
assert_eq "12"  "$(psql_q 'select count(*) from product;')"     "products survive"
assert_eq "203" "$(psql_q 'select count(*) from offer;')"       "offers survive"
assert_eq "1"   "$(psql_q 'select count(*) from "user";')"    "the admin user survives"
assert_eq "0"   "$(docker inspect "${PROJECT}-backend-1" --format '{{.RestartCount}}')" \
  "the backend did not restart-loop (a failed re-seed used to)"
assert_contains "$(dc logs backend 2>&1 | tail -80)" "Nothing to do" \
  "the seed recognised an already-seeded marketplace"

# ---------------------------------------------------------------------------
step "Object storage"

docker run -d --name "$RUSTFS" --network "${PROJECT}_default" -p "${RUSTFS_PORT}:9000" \
  -e RUSTFS_ACCESS_KEY=smokekey -e RUSTFS_SECRET_KEY=smokesecret123 \
  -e RUSTFS_VOLUMES=/data rustfs/rustfs:latest >/dev/null 2>&1
wait_for 90 "curl -s -o /dev/null ${RUSTFS_BASE}/" || bad "RustFS did not start"

rclone_in_backup() {
  # shellcheck disable=SC2016  # $S3_* must expand inside the container, not here
  dc run --rm --entrypoint sh backup -c '
    export RCLONE_CONFIG_STORE_TYPE=s3 RCLONE_CONFIG_STORE_PROVIDER=Other \
      RCLONE_CONFIG_STORE_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID \
      RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY \
      RCLONE_CONFIG_STORE_REGION=us-east-1 RCLONE_CONFIG_STORE_ENDPOINT=$S3_ENDPOINT \
      RCLONE_CONFIG_STORE_FORCE_PATH_STYLE=true
    '"$1" 2>/dev/null
}
rclone_in_backup 'rclone mkdir store:smoke-backups; rclone mkdir store:smoke-media' >/dev/null 2>&1

assert_contains "$(dc run --rm backup check 2>&1)" "OK." "backup check reports a reachable bucket and database"
assert_contains "$(dc run --rm backup once 2>&1)" "backup complete" "a backup is taken and stored"

# Damage the database, then restore the dump over it.
DUMP=$(dc run --rm backup list 2>/dev/null | grep -oE 'mercur-[0-9TZ-]+\.dump' | tail -1)
if [ -n "$DUMP" ]; then
  docker exec "${PROJECT}-postgres-1" psql -U mercur -d mercur -q -c "update store set name='WRECKED';" >/dev/null 2>&1
  dc stop backend worker >/dev/null 2>&1
  dc run --rm backup restore "$DUMP" >/dev/null 2>&1
  dc start backend worker >/dev/null 2>&1
  assert_eq "SmokeRenamed" "$(psql_q 'select name from store;')" "pg_dump/pg_restore round-trips the database"
else
  bad "no dump found to restore"
fi

# ---------------------------------------------------------------------------
step "Email links reach the container that sends them"

# Emails are sent from the WORKER, not the backend — the subscribers run there. So it is
# the worker's environment that decides whether a password reset link points anywhere.
# Adding a variable to the backend block alone leaves every reset email linkless, and
# nothing else in this suite would notice.
assert_contains "$(dc exec -T worker printenv MERCUR_ADMIN_URL 2>/dev/null)" "/dashboard" \
  "the worker gets the admin panel URL that operator reset links are built from"
assert_contains "$(dc exec -T worker printenv MERCUR_VENDOR_URL 2>/dev/null)" "/seller" \
  "...and the vendor panel URL for seller reset links"

# No default on purpose: this stack serves no storefront. It must be present and empty
# rather than absent, so the subscriber sees "not configured" instead of inheriting
# whatever a future compose change leaves lying around.
dc exec -T worker printenv MERCUR_STOREFRONT_URL >/dev/null 2>&1
assert_eq "0" "$?" "MERCUR_STOREFRONT_URL is passed through even when empty"

# ---------------------------------------------------------------------------
step "Uploads in S3, and migrating the old ones"

# Still in local mode: put a file on the volume and attach it to a product, so the
# migration has something real to move. The redeploy step above deliberately destroyed
# the uploads volume, so without this the migration correctly reports nothing to do and
# the assertions below pass for the wrong reason.
TOKEN=$(curl -s -X POST "${BASE}"/auth/user/emailpass -H 'Content-Type: application/json' \
  -d '{"email":"smoke@test.local","password":"SmokePass123!"}' | sed 's/.*"token":"//;s/".*//')
LOCAL_URL=$(curl -s -X POST "${BASE}"/admin/uploads -H "Authorization: Bearer $TOKEN" \
  -F "files=@$WORK/f.txt" | sed 's/.*"url":"//;s/".*//')
PROD_ID=$(curl -s "${BASE}/admin/products?limit=1" -H "Authorization: Bearer $TOKEN" \
  | sed 's/.*"products":\[{"id":"//;s/".*//')
curl -s -X POST "${BASE}/admin/products/${PROD_ID}" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"thumbnail\":\"${LOCAL_URL}\",\"images\":[{\"url\":\"${LOCAL_URL}\"}]}" >/dev/null
assert_eq "1" "$(psql_q "select count(*) from image where url like '%/static/%' and url not like '%jsdelivr%';")" \
  "a local upload is attached to a product, ready to migrate"

sed -i.bak 's/^FILE_STORAGE=local$/FILE_STORAGE=s3/' "$WORK/.env"
dc up -d --no-build --force-recreate backend worker >/dev/null 2>&1
wait_for 300 "curl -fsS ${BASE}/health" || bad "backend did not restart in s3 mode"

TOKEN=$(curl -s -X POST "${BASE}/auth/user/emailpass" -H 'Content-Type: application/json' \
  -d '{"email":"smoke@test.local","password":"SmokePass123!"}' | sed 's/.*"token":"//;s/".*//')
S3_URL=$(curl -s -X POST "${BASE}/admin/uploads" -H "Authorization: Bearer $TOKEN" \
  -F "files=@$WORK/f.txt" | sed 's/.*"url":"//;s/".*//')
assert_contains "$S3_URL" "smoke-media" "FILE_STORAGE=s3 stores uploads in the bucket"

# The migration must leave alone the seeded catalogue, whose images are CDN URLs that
# merely contain /static/ in their path. Getting this wrong destroys the catalogue.
CDN_BEFORE=$(psql_q "select count(*) from image where url like 'https://cdn.jsdelivr.net%';")
DRY=$(dc run --rm backup migrate-uploads 2>&1)
assert_contains "$DRY" "DRY RUN" "migrate-uploads reports without changing anything"
assert_contains "$DRY" "total rows to rewrite: 2" \
  "it counts only this deployment's own files, not the ${CDN_BEFORE} seeded CDN URLs"
assert_eq "$CDN_BEFORE" "$(psql_q "select count(*) from image where url like 'https://cdn.jsdelivr.net%';")" \
  "a dry run leaves the database untouched"

# A private bucket must abort the migration *before* any row is rewritten.
assert_contains "$(dc run --rm backup migrate-uploads --apply 2>&1)" "not publicly readable" \
  "a private media bucket aborts the migration"
assert_eq "$CDN_BEFORE" "$(psql_q "select count(*) from image where url like 'https://cdn.jsdelivr.net%';")" \
  "...and the database is left unchanged when it aborts"

# ---------------------------------------------------------------------------
step "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
