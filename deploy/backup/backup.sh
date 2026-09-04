#!/bin/sh
# ---------------------------------------------------------------------------
# Mercur database backups to S3-compatible object storage.
#
#   backup.sh loop              take a backup every BACKUP_INTERVAL_SECONDS (default)
#   backup.sh once              take one backup and exit
#   backup.sh list              list the backups currently in the bucket
#   backup.sh restore <name>    restore one backup by file name (asks nothing — be sure)
#   backup.sh check             verify the configuration and the bucket, take nothing
#   backup.sh drill             prove the newest backup actually restores, into a scratch
#                               database, without touching the live one
#   backup.sh migrate-uploads   move files already on the uploads volume into the media
#                               bucket and repoint the database at them. Reports only,
#                               unless you add --apply. Add --skip-public-check only if
#                               the bucket's public URL is unreachable from this
#                               container but verified working from a browser.
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
    if pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then
      log "database reachable."
    else
      die "cannot reach the database."
    fi
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

  drill)
    # An untested backup is not a backup. This restores the newest dump into a throwaway
    # database beside the real one, checks it came back readable, and drops it again. The
    # live database is never written to, so it is safe to run on a schedule against
    # production — which is the only way to learn that your backups stopped working
    # before the day you need one.
    #
    # It deliberately does NOT require the restored counts to equal the live ones. A
    # backup is a snapshot; on any marketplace taking orders the newest dump is already
    # behind by the time it lands, so comparing against live would fail every single day
    # and the drill would be switched off within a week. What is checked is that the dump
    # restores without error and that the schema and data are actually there. The counts
    # are printed next to the live ones so drift is visible to a human without being
    # treated as a failure.
    configure_rclone
    require_database_url

    LATEST=$(rclone lsf "$REMOTE" 2>/dev/null | grep '\.dump$' | sort | tail -1)
    [ -n "$LATEST" ] || die "no backups found in ${REMOTE} — nothing to drill."
    log "drilling with the newest backup: ${LATEST}"

    BASE_DB=$(printf '%s' "$DATABASE_URL" | sed 's/?.*//' | sed 's|.*/||')
    QUERY=$(printf '%s' "$DATABASE_URL" | grep -o '?.*' || true)
    SCRATCH="${BASE_DB}_drill"
    ADMIN_URL=$(printf '%s' "$DATABASE_URL" | sed "s|/${BASE_DB}\(?.*\)\{0,1\}$|/postgres${QUERY}|")
    SCRATCH_URL=$(printf '%s' "$DATABASE_URL" | sed "s|/${BASE_DB}\(?.*\)\{0,1\}$|/${SCRATCH}${QUERY}|")

    drop_scratch() { psql -d "$ADMIN_URL" -q -c "drop database if exists \"$SCRATCH\";" >/dev/null 2>&1; }
    trap drop_scratch EXIT

    drop_scratch
    psql -d "$ADMIN_URL" -q -c "create database \"$SCRATCH\";" >/dev/null || die "could not create the scratch database."

    if ! rclone cat "${REMOTE}/${LATEST}" | pg_restore -d "$SCRATCH_URL" --clean --if-exists --no-owner 2>/tmp/drill.err; then
      cat /tmp/drill.err >&2
      die "drill FAILED — ${LATEST} did not restore. Investigate now, not when you need it."
    fi

    FAILED=0
    for t in store seller product offer region; do
      live=$(psql -d "$DATABASE_URL" -tAc "select count(*) from \"$t\"" 2>/dev/null || echo "?")
      restored=$(psql -d "$SCRATCH_URL" -tAc "select count(*) from \"$t\"" 2>/dev/null || echo "?")
      if [ "$restored" = "?" ]; then
        log "  ${t}: NOT READABLE in the restored copy"
        FAILED=1
      elif [ "$live" = "$restored" ]; then
        log "  ${t}: ${restored} (live ${live})"
      else
        log "  ${t}: ${restored} (live ${live} — drifted since the backup, expected on a busy site)"
      fi
    done

    # A marketplace always has exactly one store row once migrations have run. Zero means
    # the dump restored its schema but none of its data — the failure mode that looks like
    # success right up until you rely on it.
    store_rows=$(psql -d "$SCRATCH_URL" -tAc "select count(*) from store" 2>/dev/null || echo 0)
    if [ "${store_rows:-0}" -lt 1 ] 2>/dev/null; then
      log "  the restored database has no store row — the dump carries schema but no data"
      FAILED=1
    fi

    if [ "$FAILED" -eq 0 ]; then
      log "drill passed: ${LATEST} restores cleanly and the data is there."
    else
      die "drill FAILED — see above."
    fi
    ;;

  migrate-uploads)
    # Moves what the LOCAL provider wrote into the bucket the S3 provider reads,
    # then repoints the database. Only needed once, when switching FILE_STORAGE
    # from local to s3 — new uploads already go straight to the bucket.
    require_database_url
    [ -n "$S3_FILE_BUCKET" ] || die "S3_FILE_BUCKET is not set — nothing to migrate into."
    [ -n "$S3_FILE_PUBLIC_URL" ] || die "S3_FILE_PUBLIC_URL is not set — the rewritten URLs would be wrong."
    [ -d /uploads ] || die "/uploads is not mounted; the uploads volume must be attached to this container."

    APPLY=false
    SKIP_CHECK=false
    for _arg in "$@"; do
      [ "$_arg" = "--apply" ] && APPLY=true
      [ "$_arg" = "--skip-public-check" ] && SKIP_CHECK=true
    done

    configure_rclone
    MEDIA="store:${S3_FILE_BUCKET}/${S3_FILE_PREFIX}"
    NEW_BASE="${S3_FILE_PUBLIC_URL}/${S3_FILE_PREFIX}"

    # The rewrite below keys off the file names actually present on the volume, so
    # a public URL that itself ends in one of them can never be re-rewritten. The
    # only genuinely unsafe shape is an empty base.
    [ -n "$NEW_BASE" ] || die "computed an empty destination URL."

    # The set of files to migrate — and, crucially, the ONLY rows that may be
    # rewritten. Matching on "/static/" alone is not safe: Mercur's own demo seed
    # stores catalogue images as
    # https://cdn.jsdelivr.net/gh/mercurjs/mercur@main/static/<name>.png, and a
    # naive rewrite silently repoints every one of them at a bucket that has never
    # held those files. Restricting to file names present on the volume keeps the
    # migration to files this deployment actually owns.
    find /uploads -type f ! -name '.*' | sed 's|.*/||' > /tmp/upload-names.txt
    FILE_COUNT=$(wc -l < /tmp/upload-names.txt | tr -d ' ')
    log "files on the uploads volume: ${FILE_COUNT}"

    if [ "$FILE_COUNT" -eq 0 ]; then
      log "nothing to migrate."
      exit 0
    fi

    # Every column that can hold an uploaded-file URL, confirmed against the live
    # schema. Deliberately excludes cart_line_item/order_line_item thumbnails:
    # those are historical snapshots of past orders, not live catalogue data.
    TARGETS="image:url media_image:url product:thumbnail product_variant:thumbnail inventory_item:thumbnail seller:logo seller:banner user:avatar_url order_claim_item_image:url"

    build_sql() {
      _verb="$1"   # count | update
      echo "create temp table migrated_files(name text primary key);"
      echo "\\copy migrated_files(name) from '/tmp/upload-names.txt'"
      for t in $TARGETS; do
        _tbl=${t%%:*}; _col=${t##*:}
        _base="regexp_replace(regexp_replace(\"$_col\", '[?#].*$', ''), '^.*/', '')"
        # BOTH conditions. The path check alone is unsafe (Mercur's demo seed
        # stores catalogue images at cdn.jsdelivr.net/.../static/<name>.png, which
        # a naive rewrite would repoint at a bucket that never held them). The
        # file-name check alone is unsafe too: an unrelated URL that happens to
        # end in the same file name would be clobbered. Requiring both also makes
        # re-running a clean no-op, since rewritten rows no longer match.
        _where="\"$_col\" like '%/static/%' and $_base in (select name from migrated_files)"
        if [ "$_verb" = "count" ]; then
          echo "select '${_tbl}.${_col}', count(*) from \"$_tbl\" where $_where;"
        else
          echo "update \"$_tbl\" set \"$_col\" = '${NEW_BASE}' || $_base where $_where;"
        fi
      done
    }

    log "rows referencing those files:"
    build_sql count | psql -d "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 2>/dev/null \
      | awk -F'|' '$2 > 0 { printf "[backup]   %s: %s\n", $1, $2; t+=$2 } END { printf "[backup] total rows to rewrite: %d\n", t }'

    if [ "$APPLY" != "true" ]; then
      log "DRY RUN — nothing copied, nothing changed."
      log "Re-run with --apply to copy the files and rewrite the URLs."
      exit 0
    fi

    # A dump first, so the URL rewrite is one `restore` away from being undone.
    log "taking a safety backup before changing anything..."
    take_backup

    log "copying ${FILE_COUNT} file(s) to ${MEDIA}"
    rclone copy /uploads "$MEDIA" --progress || die "copy failed — the database was not touched."

    # Prove the bucket actually serves these publicly BEFORE repointing anything.
    # A private bucket rewrites cleanly and then shows broken images everywhere.
    SAMPLE=$(head -1 /tmp/upload-names.txt)
    if [ -n "$SAMPLE" ]; then
      SAMPLE_URL="${NEW_BASE}${SAMPLE}"
      log "checking the copy is publicly readable: ${SAMPLE_URL}"
      # Anchor on the status line only. busybox wget also echoes the status inside
      # its own "wget: server returned error: HTTP/1.1 403" message, and matching
      # that too yields "server" where the code should be.
      CODE=$(wget -q -S -O /dev/null "$SAMPLE_URL" 2>&1 | awk '/^[ \t]*HTTP\//{print $2; exit}')
      if [ "$CODE" = "200" ]; then
        log "public read confirmed."
      elif [ -n "$CODE" ]; then
        # The server answered and refused. That is a real misconfiguration.
        die "the bucket is not publicly readable (HTTP ${CODE} for ${SAMPLE_URL}). Files are copied and the database is UNCHANGED — grant anonymous read on the bucket and re-run."
      elif [ "$SKIP_CHECK" = "true" ]; then
        log "WARNING: could not reach ${SAMPLE_URL} from this container; --skip-public-check given, continuing."
      else
        # No answer at all: usually the public URL is not resolvable from inside
        # the container — split-horizon DNS, or a CDN in front of the bucket.
        # That is not proof the bucket is private, so say which case this is
        # rather than reporting a permissions problem that may not exist.
        die "could not reach ${SAMPLE_URL} from inside this container (no HTTP response), so the bucket could not be verified. Files are copied and the database is UNCHANGED. Check that URL from a browser: if it loads, re-run with --skip-public-check; if it does not, fix the bucket policy first."
      fi
    fi

    # One transaction: either every table is repointed or none is.
    log "rewriting URLs..."
    { echo "begin;"; build_sql update; echo "commit;"; } \
      | psql -d "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null \
      || die "URL rewrite failed and was rolled back. Files are in the bucket; the database is unchanged."

    log "migration complete. The originals are still on the uploads volume —"
    log "leave them until you have confirmed images render, then they can go."
    ;;

  *)
    die "unknown mode '$MODE' (expected: loop, once, list, restore, check, drill, migrate-uploads)"
    ;;
esac
