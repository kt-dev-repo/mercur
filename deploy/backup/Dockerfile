# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Database backup sidecar: pg_dump straight to S3-compatible object storage.
#
# postgres:16-alpine supplies pg_dump/pg_restore at the SAME major version as
# the database container — a dump taken by a newer pg_dump can be unreadable by
# an older server, so these two images must be bumped together.
#
# rclone (a single static binary, no vendor lock-in) does the S3 half. It talks
# to RustFS, AWS S3, Cloudflare R2, Backblaze B2 and DigitalOcean Spaces through
# the same configuration — only S3_ENDPOINT changes.
# ---------------------------------------------------------------------------
FROM rclone/rclone:1.75 AS rclone

FROM postgres:16-alpine
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["loop"]
