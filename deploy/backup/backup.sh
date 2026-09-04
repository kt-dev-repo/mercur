#!/bin/sh
# ---------------------------------------------------------------------------
# Mercur database backups to S3-compatible object storage.
#
#   backup.sh loop              take a backup every BACKUP_INTERVAL_SECONDS (default)
#   backup.sh once              take one backup and exit
#   backup.sh list              list the backups currently in the bucket
#   backup.sh restore <name>    restore one backup by file name (asks nothing — be sure)
#   backup.sh check             verify the configuration and the bucket, take nothing
#
# Everything is driven by environment variables; see deploy/.env.example.
# ---------------------------------------------------------------------------
set -e

MODE="${1:-loop}"

: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_RETENTION_DAYS:=30}"
: "${S3_PREFIX:=mercur}"
: "${S3_REGION:=us-east-1}"

log() { echo "[backup] $*"; }
die() { echo "[backup] $*" >&2; exit 1; }

# rclone is configured entirely through RCLONE_CONFIG_<REMOTE>_<KEY> variables,
# so there is no config file to mount and no secret written to disk.
configure_rclone() {
  [ -n "$S3_BUCKET" ] || die "S3_BUCKET is not set — nothing to back up to."
  [ -n "$S3_ACCESS_KEY_ID" ] || die "S3_ACCESS_KEY_ID is not set."
  [ -n "$S3_SECRET_ACCESS_KEY" ] || die "S3_SECRET_ACCESS_KEY is not set."

  export RCLONE_CONFIG_STORE_TYPE=s3
  # "Other" keeps rclone from assuming AWS-only behaviour; it is the correct
  # provider value for RustFS and every other self-hosted S3 implementation.
  export RCLONE_CONFIG_STORE_PROVIDER="${S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_STORE_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
  export RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_STORE_REGION="$S3_REGION"
  # Path-style addressing: RustFS and most self-hosted S3 servers do not serve
  # virtual-hosted buckets (bucket.host), which is rclone's default for AWS.
  export RCLONE_CONFIG_STORE_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"
  [ -n "$S3_ENDPOINT" ] && export RCLONE_CONFIG_STORE_ENDPOINT="$S3_ENDPOINT"

  REMOTE="store:${S3_BUCKET}/${S3_PREFIX}"
}

require_database_url() {
  [ -n "$DATABASE_URL" ] || die "DATABASE_URL is not set."
}

take_backup() {
  # On a first deploy the sidecar can win the race against Medusa's migrations:
  # postgres reports healthy long before the schema exists, and the loop then
  # stores a perfectly valid dump of an empty database. Harmless to restore but
  # actively misleading to find in the bucket, so skip until there is something
  # to back up. `store` is created by Medusa's own migrations.
  if ! psql -d "$DATABASE_URL" -tAc 'select 1 from store limit 1' >/dev/null 2>&1; then
    log "database is not migrated yet (no store row) — skipping this backup."
    return 0
  fi

  STAMP=$(date -u +%Y%m%d-%H%M%SZ)
  NAME="mercur-${STAMP}.dump"
  log "dumping database to ${REMOTE}/${NAME}"

  # -Fc is Postgres's compressed custom format, the one pg_restore can filter
  # and reorder. Streaming it straight into rclone keeps the dump off this
  # container's disk entirely, so a large database cannot fill the sidecar up.
  #
  # pipefail is not in POSIX sh, so guard the pipe explicitly: without this a
  # pg_dump that dies mid-stream still exits 0 through rclone and a truncated
  # dump gets stored as if it were good.
  if pg_dump -d "$DATABASE_URL" -Fc 2>/tmp/dump.err | rclone rcat "${REMOTE}/${NAME}"; then
    if [ -s /tmp/dump.err ]; then
      log "pg_dump wrote warnings:"; cat /tmp/dump.err >&2
    fi
  else
    cat /tmp/dump.err >&2 || true
    rclone deletefile "${REMOTE}/${NAME}" 2>/dev/null || true
    die "backup FAILED — the partial object was removed."
  fi

  SIZE=$(rclone size --json "${REMOTE}/${NAME}" 2>/dev/null | sed 's/.*"bytes":\([0-9]*\).*/\1/')
  [ -n "$SIZE" ] && [ "$SIZE" -gt 0 ] 2>/dev/null || die "stored object is empty — treating as a failed backup."
  log "backup complete: ${NAME} (${SIZE} bytes)"

  if [ "$BACKUP_RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
    log "pruning backups older than ${BACKUP_RETENTION_DAYS} days"
    rclone delete --min-age "${BACKUP_RETENTION_DAYS}d" "$REMOTE" || log "prune failed (backup itself is safe)"
  fi
}

case "$MODE" in
  check)
    configure_rclone
    require_database_url
    log "configuration looks complete; checking the bucket..."
    rclone lsd "store:${S3_BUCKET}" >/dev/null || die "cannot reach the bucket — check S3_ENDPOINT, credentials, and that the bucket exists."
    log "bucket reachable."
    pg_isready -d "$DATABASE_URL" >/dev/null 2>&1 && log "database reachable." || die "cannot reach the database."
    log "OK."
    ;;

  once)
    configure_rclone; require_database_url; take_backup
    ;;

  list)
    configure_rclone
    rclone lsl "$REMOTE"
    ;;

  restore)
    NAME="$2"
    [ -n "$NAME" ] || die "usage: backup.sh restore <file-name>   (see: backup.sh list)"
    configure_rclone; require_database_url
    log "restoring ${NAME} over the current database..."
    # --clean --if-exists so this works whether the database is empty or in use.
    # Stop the backend and worker first: a running server caches rows that the
    # restore is replacing underneath it.
    rclone cat "${REMOTE}/${NAME}" | pg_restore -d "$DATABASE_URL" --clean --if-exists --no-owner
    log "restore complete."
    ;;

  loop)
    configure_rclone; require_database_url
    log "backup loop started: every ${BACKUP_INTERVAL_SECONDS}s, keeping ${BACKUP_RETENTION_DAYS} days, to ${REMOTE}"
    while true; do
      # A failed backup must not kill the loop — the next one may well succeed.
      # The subshell is load-bearing: `die` calls `exit`, which in POSIX sh ends
      # the whole script, not just the function, so a bare `take_backup || ...`
      # does NOT catch it. Without the parentheses an unreachable S3 endpoint
      # exits the container on every attempt, and `restart: unless-stopped` turns
      # that into a hot crash loop hammering pg_dump — measured at 43 restarts in
      # 75 seconds before this was fixed.
      ( take_backup ) || log "backup attempt failed; retrying at the next interval."
      sleep "$BACKUP_INTERVAL_SECONDS"
    done
    ;;

  *)
    die "unknown mode '$MODE' (expected: loop, once, list, restore, check)"
    ;;
esac
