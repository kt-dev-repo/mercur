# Plan — choose local or S3 (RustFS) storage for uploaded images and videos

Status: **implemented and verified**. Branch base: `fix/redeploy-data-loss` @ `47bf1b3`.

## Context

The database is backed up to RustFS on a schedule, but **uploaded files are the one thing
still tied to a local Docker volume**. Product images, product videos, seller logos and
banners all go through Medusa's file module, which this deployment pins to
`@medusajs/medusa/file-local`, writing into the `uploads` volume at `/app/static`. Lose
that volume — the same way the database volume can be lost — and every image in the
marketplace 404s, with nothing to restore from.

The goal: make storage a **deliberate, reversible choice**, and provide a way to move
files that already exist.

## What the installed packages allow

Three things were established by reading the shipped code, not from memory:

- **Medusa 2.18 permits exactly one file provider.**
  `@medusajs/file/dist/services/file-provider-service.js` throws
  `File module should be initialized with exactly one provider` when more than one is
  registered. So the choice is per-deployment; a per-upload choice would need custom code.
- **`@medusajs/file-s3` v2.18.0 is already installed** — "Supports any S3-compatible
  storage provider". It exposes `endpoint` and `additional_client_config` (for
  `forcePathStyle`), which is what RustFS needs. No new dependency.
- **No mime-type restriction exists in the backend upload path.** Both
  `@medusajs/medusa/dist/api/admin/uploads/route.js` and Mercur's `vendor/uploads/route.js`
  pass `mimetype` straight through, so videos work at the API and provider level. Any
  limit on *selecting* a video is in the panel's file picker, outside this change.

## Design

A named setting, not a side effect:

```
FILE_STORAGE=local     # the uploads volume (default, unchanged behaviour)
FILE_STORAGE=s3        # RustFS / AWS S3 / R2 / B2 / Spaces
```

The S3 branch reuses the connection variables already introduced for the backup sidecar
(`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`,
`S3_FORCE_PATH_STYLE`) plus `S3_FILE_BUCKET`, `S3_FILE_PUBLIC_URL`, `S3_FILE_PREFIX`,
`S3_FILE_ACL` — one RustFS, two buckets.

Defaults chosen from the provider source, each for a reason:

- **`acl: false`** — omits the ACL header entirely (`resolveAcl` returns `undefined` when
  `config_.acl === false`). Self-hosted S3 servers commonly reject or ignore canned ACLs;
  public read comes from a bucket policy. `S3_FILE_ACL=public-read` restores AWS behaviour.
- **`forcePathStyle: true`** — RustFS addresses buckets as `endpoint/bucket`.
- **Fail fast at boot** when `FILE_STORAGE=s3` without bucket, public URL or credentials.
  The provider builds every URL as `` `${file_url}/${key}` ``, so a missing `file_url`
  stores images as `undefined/foo.png`: the upload reports success and the whole
  catalogue renders broken. An unknown `FILE_STORAGE` value is rejected rather than
  silently falling back to local.

**Separate buckets.** Media must be publicly readable; database dumps must not be.

**Switching is non-destructive both ways.** Stored URLs are absolute, so files already
uploaded keep resolving from wherever they were written. The `uploads` volume therefore
stays mounted in both modes.

## Migrating files that already exist

Added as `backup.sh migrate-uploads`, in the existing sidecar — it already has `psql`,
`pg_dump` and `rclone`. **Dry run by default; `--apply` commits.**

`--apply`, in order:

1. takes a database backup, so the rewrite is one `restore` from undone;
2. copies files into the media bucket — the volume is mounted **read-only**, so the
   originals cannot be damaged;
3. fetches one copied file over plain HTTP and **aborts if the bucket refuses it**,
   before touching a single row — a private bucket otherwise migrates "successfully" and
   breaks every image. If the URL is simply unreachable from the container (rather than
   refused) it says so and points at `--skip-public-check`, instead of blaming permissions;
4. rewrites URLs in **one transaction** across the nine columns confirmed against the live
   schema: `image.url`, `media_image.url`, `product.thumbnail`,
   `product_variant.thumbnail`, `inventory_item.thumbnail`, `seller.logo`, `seller.banner`,
   `user.avatar_url`, `order_claim_item_image.url`.

A row is rewritten only when **both** hold: the URL contains `/static/`, *and* its file
name is one of the files actually on the volume. Either condition alone is unsafe — see
"What verification actually found" below. The new value is built from the file name rather
than by string-replacing the old host, so it survives a domain or scheme change since
upload; and because a rewritten row no longer contains `/static/`, re-running is a no-op.

`cart_line_item.thumbnail` and `order_line_item.thumbnail` are deliberately left alone —
historical snapshots of past orders, not live catalogue data.

Originals stay on the volume; the docs say to keep them until images are confirmed.

## Files changed

| File | Change |
|---|---|
| `deploy/medusa-config.production.ts` | `OVERLAY 4/4`: provider selected by `FILE_STORAGE`, with boot-time validation |
| `deploy/backup/backup.sh` | New `migrate-uploads` mode (dry-run default, `--apply`) |
| `deploy/docker-compose.yml` | `FILE_STORAGE` + `S3_FILE_*` on `backend` and `worker`; `uploads:/uploads:ro` and media settings on `backup` |
| `deploy/.env.example` | "Where uploaded files live" section |
| `deploy/README.md` | `Storing uploads in S3 (RustFS)` + `Moving the files you already have`; updated backup and go-live notes |

The worker gets identical file configuration — it loads the same modules, and a mismatch
breaks background jobs in a way the backend never shows.

## Verification

Against the Podman smoke stack (`mercursmoke`), with RustFS running as `rustfstest`.

1. **Default unchanged** — deploy with `FILE_STORAGE` unset; upload via `POST /admin/uploads`;
   assert a `/static/...` URL and the file on the volume.
2. **Boot guards** — `s3` without bucket, without public URL, and `FILE_STORAGE=nonsense`
   each refuse to start with a message naming the problem.
3. **S3 mode end to end** — second bucket `mercur-media` with anonymous read; backend *and*
   worker start; upload an image and an `.mp4`; assert the object is in the bucket, the URL
   has the public form, and **`curl` without credentials returns 200**; confirm it renders
   in the admin panel in a browser.
4. **Mixed storage** — old `/static/` URLs still 200 after switching to `s3`; S3 URLs still
   200 after switching back to `local`.
5. **Migration** — dry run reports correct counts and changes nothing; `--apply` copies,
   verifies, rewrites; images render; re-running is a no-op; a private bucket aborts before
   the database is touched.
6. **Standing regression** — `down`/`up` preserves store, currencies, regions, sellers,
   products, offers and the admin user; seed no-ops; both panels sign in; `backup check`
   and `backup once` pass.

## What verification actually found

Two defects that only surfaced by running the migration against real seeded data.

**1. The rewrite would have destroyed the demo catalogue.** Matching rows on `/static/`
looked obviously right and was wrong: Mercur's own seed stores catalogue images as
`https://cdn.jsdelivr.net/gh/mercurjs/mercur@main/static/<name>.png`. The first dry run
reported **26 rows** to rewrite — 25 of them external CDN URLs that would have been
repointed at a bucket that never held those files, silently breaking every demo product.
The predicate now requires **both** that the URL contains `/static/` *and* that its file
name is one of the files actually on the volume. Requiring both also makes a re-run a
clean no-op, since rewritten rows no longer match.

**2. The public-read check reported the wrong status.** BusyBox `wget -S` prints the
status line twice — once as a header, once inside its own `wget: server returned error:`
message — so the original `awk` returned `server` where the HTTP code belonged. Anchored
to the status line, and the check now distinguishes *refused* (a real permissions problem,
abort) from *unreachable* (the container cannot resolve the public URL — split-horizon DNS
or a CDN in front of the bucket), which is not proof of anything and offers
`--skip-public-check` instead of a misleading error.

## Verification results

| Check | Result |
|---|---|
| `FILE_STORAGE` unset / `local` → config loads, upload returns `/static/...`, file on volume | pass |
| A configured `S3_FILE_BUCKET` no longer implies S3 — the switch is explicit | pass |
| `s3` missing bucket / public URL / credentials → refuses to boot, naming each | pass |
| `FILE_STORAGE=nonsense` → refuses to boot | pass |
| `s3` fully configured → config loads; backend **and worker** start, 0 restarts | pass |
| Image and video upload to RustFS; objects present in bucket | pass |
| Uploaded URLs fetch 200 with no credentials, correct content-type | pass |
| Files uploaded before the switch still serve from `/static` afterwards | pass |
| Migration dry run reports counts and changes nothing | pass |
| Migration leaves the 13 seeded jsdelivr rows untouched | pass |
| Private bucket → aborts with `HTTP 403`, files copied, **database unchanged** | pass |
| Public bucket → copies, verifies, rewrites `image.url` and `product.thumbnail` | pass |
| Migrated file served 200 `image/png` from both the internal and browser address | pass |
| Re-running the migration finds 0 rows | pass |
| Regression: `down`/`up` preserves store, sellers, products, offers; seed no-ops; both panels 200; `backup check` OK; 0 restarts anywhere | pass |

## Known limits

- **The media bucket must be publicly readable.** Verified rather than assumed (step 3/5).
- **Deleting a pre-switch file does not remove it from disk** — the delete routes through
  the new provider, which lacks the key. The row goes, the file is orphaned. Migrating
  first avoids it. Documented, not engineered around.
- **A full rebuild (~8 min) is needed per config change**, since
  the config is baked into the image (settings now live in `src/lib/production-overlay.ts`).
