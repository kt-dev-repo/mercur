# Deploying Mercur on Dokploy

This deploys your whole marketplace as one service. When it is running you get:

| URL | What it is |
|---|---|
| `https://YOUR-DOMAIN/dashboard` | Admin panel — you, the marketplace operator |
| `https://YOUR-DOMAIN/seller` | Vendor panel — your sellers |
| `https://YOUR-DOMAIN/store` | Store API — for your storefront |
| `https://YOUR-DOMAIN/health` | Returns 200 when the backend is up |

Follow the steps in order. Everything you configure is done in the Dokploy web
interface — you never edit a file in this repository.

## Before you start

- A Dokploy host with at least **4 GB of RAM**. The first build is heavy.
- A **domain name** you can point at that host, e.g. `api.example.com`.
- This repository pushed to a Git repo Dokploy can read.

---

## Step 1 — point your domain at the server

Create a DNS **A record** for your hostname pointing at your Dokploy server's IP
address. Do this first: certificates cannot be issued until it resolves.

Check it with:

```bash
dig +short api.example.com
```

You should see your server's IP.

## Step 2 — create the service in Dokploy

1. Open your project and choose **Create Service → Compose**
2. **Provider**: the Git repository holding this code, branch `main`
3. **Compose Path**: `./deploy/docker-compose.yml`

Do not deploy yet — set the environment first.

## Step 3 — set the environment

Open the service's **Environment** tab and paste this in. Replace
`api.example.com` with your own hostname everywhere it appears, fill in the three
secrets, then Save.

```
DOMAIN=api.example.com
MERCUR_BACKEND_URL=http://api.example.com

JWT_SECRET=
COOKIE_SECRET=
POSTGRES_PASSWORD=

POSTGRES_USER=mercur
POSTGRES_DB=mercur

STORE_CORS=http://api.example.com
ADMIN_CORS=http://api.example.com
VENDOR_CORS=http://api.example.com
AUTH_CORS=http://api.example.com

RUN_MIGRATIONS=true
RUN_SEED=false

INSECURE_COOKIES=true

FILE_STORAGE=local
```

Generate `JWT_SECRET` and `COOKIE_SECRET` by running this twice, using a
different result for each:

```bash
openssl rand -base64 48
```

Generate `POSTGRES_PASSWORD` with **hex, not base64**:

```bash
openssl rand -hex 32
```

Three warnings worth reading before you save.

**Do not use `openssl rand -base64` for `POSTGRES_PASSWORD`.** It emits `/`, `+`
and `=`, and this password gets interpolated straight into a `postgres://…`
connection URL. A `/` in the password makes that URL unparseable — the backend
never connects, retries for two minutes and exits, and nothing in the error
mentions the password. Roughly two out of three base64 passwords contain one. If
you already have such a password and want to keep it, percent-encode it in a
`DATABASE_URL` you set yourself (`/` → `%2F`, `+` → `%2B`, `=` → `%3D`).

**Set `POSTGRES_PASSWORD` once and never change it.** Postgres writes it into the
database on first start. Changing it later does not update the database, it just
locks your backend out — and the only fix is deleting the database volume, which
deletes your data.

**Start with `http://`, not `https://`.** You do not have a certificate yet.
Step 6 covers switching over once you do.

**`INSECURE_COOKIES=true` is required while you are on `http://`.** Medusa marks
the session cookie `Secure` whenever `NODE_ENV=production`, and no browser will
store a `Secure` cookie from an `http` page — so the panels accept your password,
return 200, and drop you straight back on the login screen with no error at all.
This setting removes the flag. It is a genuine downgrade: sessions travel in the
clear. Step 6 turns it back off.

### Why there are two URL settings

`DOMAIN` and `MERCUR_BACKEND_URL` look like duplicates. They are not:

- **`DOMAIN`** — just the hostname, no `http://`, no trailing slash. Dokploy's
  router uses it to recognise requests meant for your marketplace.
- **`MERCUR_BACKEND_URL`** — the full address including `http://` or `https://`.
  It is built into the admin and vendor panels so the browser knows where to send
  API requests.

They must refer to the same host, and the scheme on `MERCUR_BACKEND_URL` must
match what you type into your browser. If they disagree, the login page appears
but signing in fails with "Failed to fetch".

## Step 4 — deploy

Click **Deploy**.

The first build takes roughly **10–20 minutes**. It downloads the full Medusa
dependency tree and compiles both panels. Later deploys reuse the cache and are
much faster.

When it finishes, check it:

```bash
curl -i http://api.example.com/health
```

`HTTP/1.1 200 OK` means you are up. Anything else — start at
[Troubleshooting](#troubleshooting).

## Step 5 — create your admin user

**A fresh deployment has no users.** Nothing creates an administrator for you, so
you must create one before you can sign in.

Open the service's **Terminal** in Dokploy, select the `backend` container, and
run:

```bash
cd /app && npx medusa user -e you@example.com -p 'your-password'
```

Wait for `User created successfully.`

`cd /app` is required — Dokploy's terminal starts you in `/`, where the command
cannot find itself and fails with `could not determine executable to run`. Do not
use `sudo`; it is not installed and is not needed.

Confirm it worked before opening a browser:

```bash
curl -s -X POST http://api.example.com/auth/user/emailpass \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
```

A long `{"token":"eyJ..."}` means success. Now sign in at
`http://api.example.com/dashboard`. If the page accepts your password and then
returns to the login screen, `INSECURE_COOKIES` is not set — see
[Troubleshooting](#the-panel-accepts-the-password-then-returns-to-the-login-screen).

## Step 6 — switch on HTTPS

Once DNS resolves, Dokploy can obtain a Let's Encrypt certificate for your
domain. After `https://api.example.com/health` works:

1. Go back to the **Environment** tab
2. Change **every** `http://` to `https://` — that is `MERCUR_BACKEND_URL` and
   all four `*_CORS` values
3. Set `INSECURE_COOKIES=false` — this is the point of the exercise; leaving it
   on keeps your session cookies unencrypted
4. Save, then click **Rebuild**

**It must be Rebuild, not Restart.** `MERCUR_BACKEND_URL` is compiled into the
panels' JavaScript, and only a rebuild recompiles them. A restart leaves the
panels calling `http://` from an `https://` page, which browsers block — you get
"Failed to fetch" on login.

---

## Troubleshooting

### Every page shows a plain `404 page not found`

That page comes from Dokploy's router, not from Mercur — it means no route
matches your hostname. Either `DOMAIN` is not set, or it does not match the
address you are visiting. Fix it in the **Environment** tab and deploy again.

### The deploy stops immediately with "required variable DOMAIN is missing a value"

`DOMAIN` is empty. This check is deliberate: deploying without it would produce a
router matching nothing, which looks exactly like the 404 above. Set it and
deploy again.

### The login page loads, but signing in says "Failed to fetch"

The panels are calling a different address than the one in your address bar —
almost always an `http://` / `https://` mismatch. Check what they were built
with:

```bash
ASSET=$(curl -s http://api.example.com/dashboard/ | grep -o '/dashboard/assets/index-[^"]*\.js' | head -1)
curl -s "http://api.example.com$ASSET" | grep -o 'backendUrl:"[^"]*"'
```

The address it prints must match your browser's, scheme included. If it does not,
correct `MERCUR_BACKEND_URL` and **Rebuild**.

### The panel accepts the password, then returns to the login screen

No error, no failed request — the login call succeeds and the page just comes
back. You are on `http://` with `INSECURE_COOKIES` unset or false.

Medusa marks the session cookie `Secure` in production, and browsers refuse to
store a `Secure` cookie from a plain-http page. Express does not treat that as an
error: it answers 200 and simply omits the cookie. You can see it from the host —
there is no `set-cookie` header at all:

```bash
TOKEN=$(curl -s -X POST http://api.example.com/auth/user/emailpass \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}' | sed 's/.*"token":"//;s/".*//')
curl -s -i -X POST http://api.example.com/auth/session \
  -H "Authorization: Bearer $TOKEN" | grep -i '^set-cookie' || echo "no cookie set"
```

Set `INSECURE_COOKIES=true` and **Rebuild**, or finish [Step 6](#step-6--switch-on-https)
and use https — on https the cookie works and this setting is not needed.

### Signing in says "Invalid email or password"

If `/health` returns 200 and the panel loads, the deployment is healthy and the
credentials genuinely did not match. Usually this means no account was ever
created — see [Step 5](#step-5--create-your-admin-user). Check:

```bash
docker exec $(docker ps -qf name=postgres) psql -U mercur -d mercur \
  -c 'select id, email from "user";'
```

`(0 rows)` confirms it. Run the Step 5 command and try again.

An account spans two tables: `user` holds the identity, `provider_identity` holds
the password. `medusa user` writes both. A `user` row without a matching
`provider_identity` gives this same error.

### The backend never starts: "DATABASE_URL is not a usable postgres URL"

Your `POSTGRES_PASSWORD` contains a character that is not URL-safe — almost
always a `/` from `openssl rand -base64`. Compose builds `DATABASE_URL` by
pasting the password into a `postgres://…` string, and a `/` breaks it.

This is a first-deploy problem, so nothing is lost by fixing it properly:
generate a new password with `openssl rand -hex 32`, update `POSTGRES_PASSWORD`
in the Environment tab, delete the `postgres-data` volume (it was initialised
with the old password) and deploy again.

If the database already holds data you need, set `DATABASE_URL` yourself instead
and percent-encode the password there: `/` → `%2F`, `+` → `%2B`, `=` → `%3D`.

### After a redeploy the marketplace is empty — no currencies, regions or sellers

A normal redeploy does not touch your data: the database lives in the
`postgres-data` volume, which survives `down`/`up` and rebuilds. If everything is
gone, the volume itself is gone. That happens when the Compose project is deleted
and recreated, when the project name changes (Dokploy derives volume names from
it), or after a `docker system prune --volumes` on the host.

Check whether the volume still holds data:

```bash
docker exec $(docker ps -qf name=postgres) psql -U mercur -d mercur \
  -c 'select name from store;' -c 'select count(*) from seller;'
```

A store named `Medusa Store` and zero sellers means a fresh, empty database — the
volume was recreated. Restore from a backup, or start over. **Take Postgres
backups before you rely on this stack**; Dokploy can schedule them.

### After a redeploy a currency or the store name reverted

Older versions of this stack rewrote the store's name and currency list every
time the seed ran, and tracked "already seeded" with a marker file on the
*uploads* volume — a different volume from the data it was guarding. If the
uploads volume was recreated the seed ran again over live data and reset those
fields; if the database volume was recreated instead, the marker survived, the
seed was skipped, and you got an empty marketplace behind a passing healthcheck.

Both are fixed. The seed now asks the database whether it has already run, and
adds its demo currencies to whatever the store already has instead of replacing
them. If you are upgrading from an older deploy, delete the stale marker so
nothing depends on it any more:

```bash
docker exec $(docker ps -qf name=backend) rm -f /app/static/.mercur-seeded
```

### The backend restarts over and over with "already exists"

A failed seed used to take the whole container down with it: the entrypoint
exited, Compose restarted it, the seed failed the same way, forever. Seeding is
now non-fatal — the server starts and logs a warning instead. Re-run the seed by
hand once you have fixed the cause:

```bash
docker exec -w /app $(docker ps -qf name=backend) npx medusa exec ./src/scripts/seed.js
```

One limit worth knowing: the seed handles "already fully seeded" and "not seeded
at all" cleanly, but it cannot resume from an arbitrary half-finished state — if
it died partway through creating sellers, a re-run may fail on whatever it
already wrote. Demo data is not worth untangling by hand: drop the database
volume and deploy again, or simply leave `RUN_SEED=false` and build your catalog
in the panel. Either way the site keeps serving in the meantime.

### The vendor panel shows fewer stores than the admin panel

This is expected, not a bug. The two panels answer different questions:

- **Admin** (`/dashboard`) lists **every seller on the marketplace**, in any
  status, from `GET /admin/sellers`.
- **Vendor** (`/seller`) lists only **the stores the signed-in member belongs
  to**, from `GET /vendor/sellers`, and hides terminated ones.

The demo seed creates three sellers, each with its own member. So the admin panel
shows three stores, and each demo seller signing in to the vendor panel sees one
— their own. To let one person see several stores in the vendor panel, add their
member account to each seller from the admin panel.

### The worker container never starts

It waits for the backend to report healthy, which only happens once migrations
have finished. On a first deploy that can take several minutes. If the backend
never becomes healthy, read its logs — the real error is there.

---

## Reference

Everything below is background. You do not need it to deploy.

### What is in this folder

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the backend image with both panels compiled in |
| `entrypoint.sh` | Waits for Postgres, runs migrations, then starts Medusa |
| `docker-compose.yml` | Postgres, Redis, backend and worker |
| `medusa-config.production.ts` | Production config overlay — adds Redis and worker mode |
| `prepare-artifact.mjs` | Build-time fixups so the runtime image installs cleanly |
| `.env.example` | The Step 3 block, plus the optional settings listed below |
| `backup/` | The S3 sidecar — scheduled `pg_dump` to RustFS/S3, and the uploads migration |

The upstream project is left untouched. Every deployment file lives in this
folder, so pulling a newer Mercur never conflicts with it. The production config
is applied as an overlay *inside the image only*, leaving
`packages/api/medusa-config.ts` exactly as Mercur ships it.

### Before you go live

- **Back up Postgres.** Your data lives in the `postgres-data` volume, and
  nothing recreates it for you. See [Backing up and
  restoring](#backing-up-and-restoring) below — do this before you take orders,
  not after.
- **Consider pinning the volume names.** By default they are scoped to the
  Compose project, so renaming or recreating the Dokploy service leaves your
  data behind in an orphaned volume. See [Surviving a service
  rename](#surviving-a-service-rename).
- **Uploads default to a local volume** at `/app/static`. They survive redeploys,
  but the database backups do not cover them and they cannot be shared across
  multiple backend replicas. Set `FILE_STORAGE=s3` to put them in RustFS instead —
  see [Storing uploads in S3](#storing-uploads-in-s3-rustfs). Required before
  scaling past one backend.
- **Only `backend` runs migrations.** The worker deliberately does not, so two
  containers never migrate at once. Preserve that if you add services.
- **Upgrades keep your data.** A new image is deployed over the same volumes and
  `medusa db:migrate` brings the schema forward in place. It runs with
  `--execute-safe-links`, so link changes introduced by an upgrade are applied
  only where they are safe and never stop the container on a confirmation prompt
  it has no terminal to answer. If an upgrade reports an unsafe link action, take
  a backup and then run it deliberately:
  `npx medusa db:migrate --execute-all-links`.
- **Redis is required.** Without it, in-flight workflow state is lost on every
  restart and the backend and worker cannot coordinate. Compose always sets it.
- **The worker is optional** for a small marketplace. Delete the `worker` service
  and set `MEDUSA_WORKER_MODE: shared` on `backend` to run everything in one
  process.
- **One image, two roles.** `backend` builds `mercur-backend:latest` and `worker`
  reuses that exact tag with a different entrypoint role, so a deploy builds once.
  Set `IMAGE_NAME` if you run several of these stacks on one host.
- **Demo data.** Set `RUN_SEED=true` before the first deploy for a demo catalog
  and three demo sellers (`seller@mercur.dev`, `kickz@mercur.dev`,
  `trailhead@mercur.dev` — all `supersecret`). Leaving it on is safe: the seed
  checks the database for the demo seller and stops if it is there, so it never
  runs over a marketplace you have started using.

### Optional settings

`.env.example` documents a few settings the Step 3 block leaves out, each with a
working default: `DATABASE_URL` (below), `TRAEFIK_CERTRESOLVER` and
`TRAEFIK_ROUTER` (change the latter only if you run several of these stacks on
one host), `FILE_BACKEND_URL`, and the storefront hooks `MERCUR_VENDOR_URL`,
`STOREFRONT_REVALIDATE_URL` and `STOREFRONT_REVALIDATE_SECRET`.

The four `*_CORS` values each fall back to `MERCUR_BACKEND_URL`, so the panels work
even if you omit them. Set them explicitly anyway: they are what you edit when you
move to `https` and when you add a storefront origin.

`INSECURE_COOKIES` is covered in Step 3 and Step 6. It only ever needs to be true
while the site is served over plain http.

`FILE_STORAGE` decides where uploaded images and videos go — `local` (the default,
the `uploads` volume) or `s3`. The `S3_FILE_*` settings that go with it, and the
`COMPOSE_PROFILES=backup` switch and its `S3_*` settings, are covered in [Storing
uploads in S3](#storing-uploads-in-s3-rustfs) and [Backing up to
S3](#backing-up-to-s3-rustfs). `S3_ENDPOINT` and the credentials are shared
between the two — one RustFS, two buckets.

`JWT_SECRET` and `COOKIE_SECRET` are checked twice — Compose refuses to start
without them, and `entrypoint.sh` refuses again for any other way the image is run.
Unset, Medusa would fall back to the literal `supersecret` and sign every session
token with a value published in this repository.

### Backing up and restoring

Your database lives in the `postgres-data` volume. Losing that volume loses the
marketplace, so take dumps somewhere else. These commands are run on the Dokploy
host; substitute your own container name if you run more than one stack.

Back up:

```bash
docker exec $(docker ps -qf name=postgres) pg_dump -U mercur -Fc mercur \
  > mercur-$(date +%Y%m%d-%H%M).dump
```

`-Fc` is Postgres's compressed custom format — a full marketplace dumps to well
under a megabyte, so this is cheap to run often. Automate it with Dokploy's
backup schedule or a host cron job, and copy the files off the server.

Restore over an existing database:

```bash
docker exec -i $(docker ps -qf name=postgres) \
  pg_restore -U mercur -d mercur --clean --if-exists --no-owner < mercur-20260903-0412.dump
```

`--clean --if-exists` drops each object before recreating it, so this works
whether the database is empty or populated. Stop the `backend` and `worker`
containers first if the site is live — restoring under an active server can
leave it holding stale rows in memory.

Check the restore landed:

```bash
docker exec $(docker ps -qf name=postgres) psql -U mercur -d mercur \
  -c 'select name from store;' -c 'select count(*) from seller;'
```

### Backing up to S3 (RustFS)

The manual `pg_dump` above is fine for a one-off. For backups that actually keep
happening, the stack ships a `backup` sidecar: it dumps the database on a
schedule, streams it straight into an S3 bucket, and prunes old copies. It works
with RustFS, AWS S3, Cloudflare R2, Backblaze B2 and DigitalOcean Spaces — only
`S3_ENDPOINT` changes between them.

It is **opt-in**. Without `COMPOSE_PROFILES=backup` the service is not even
created, so an existing deployment is unaffected.

**1. Create the bucket.** In your RustFS console, make a bucket (e.g.
`mercur-backups`) and an access key pair that can read and write it. The backup
service will not create the bucket for you — that is deliberate, so a typo in the
name fails loudly instead of quietly filling a bucket nobody looks at.

**2. Add the settings** to Dokploy's Environment tab:

```
COMPOSE_PROFILES=backup

S3_ENDPOINT=https://rustfs.example.com
S3_BUCKET=mercur-backups
S3_PREFIX=mercur
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true

BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETENTION_DAYS=30
```

`S3_FORCE_PATH_STYLE=true` matters: RustFS addresses buckets by path
(`endpoint/bucket`), not as a subdomain the way AWS does. Leave `S3_ENDPOINT`
out entirely only if you are using real AWS S3.

**3. Deploy, then prove it works** before trusting it:

```bash
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup check
```

That checks the credentials, the bucket and the database and prints `OK.` — or
tells you exactly which one is wrong. Then take one immediately, rather than
waiting a day to find out:

```bash
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup once
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup list
```

**Restoring.** Stop the app first — a running server holds rows the restore is
replacing underneath it:

```bash
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml stop backend worker
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup restore mercur-20260903-070601Z.dump
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml start backend worker
```

Notes worth having:

- Dumps are Postgres's compressed custom format and stream straight from
  `pg_dump` into the bucket, so nothing large lands on the sidecar's disk.
- A dump that fails partway is deleted from the bucket rather than left as a
  plausible-looking but truncated file.
- If S3 is unreachable the loop logs the failure and retries at the next
  interval; it does not exit and does not restart-loop.
- **Backups do not cover uploaded files.** Those live on the `uploads` volume
  unless you set `FILE_STORAGE=s3` — see [Storing uploads in
  S3](#storing-uploads-in-s3-rustfs). Use a **separate bucket** from this one:
  media has to be publicly readable, database dumps must not be.

### Storing uploads in S3 (RustFS)

Product images and videos, seller logos and banners all go through Medusa's file
module. By default they land on the `uploads` volume inside the stack — which
means **nothing backs them up**, and they cannot be shared between two backend
replicas. Pointing them at RustFS fixes both.

One setting decides it:

```
FILE_STORAGE=local     # the uploads volume (default)
FILE_STORAGE=s3        # RustFS / AWS S3 / R2 / B2 / Spaces
```

It applies to the whole deployment. Medusa allows exactly **one** file provider —
registering two makes the file module refuse to start — so this is a per-deploy
choice, not a per-upload one.

**1. Create a second bucket** (e.g. `mercur-media`) and grant it **anonymous
read**. It must be a *different* bucket from your backups: this one is world
readable, and your database dumps must never be.

**2. Add the settings.** The endpoint and credentials are shared with the backup
sidecar — one RustFS, two buckets:

```
FILE_STORAGE=s3
S3_FILE_BUCKET=mercur-media
S3_FILE_PUBLIC_URL=https://rustfs.example.com/mercur-media
```

`S3_FILE_PUBLIC_URL` is the address that serves the bucket **to a browser**. Every
image URL is built from it, so getting it wrong is quiet and expensive: uploads
report success and the whole catalogue renders broken. If it is missing entirely
the backend refuses to start rather than let that happen.

**3. Rebuild** — `medusa-config.production.ts` is compiled into the image, so a
restart is not enough.

**4. Check it.** Upload an image in the admin panel, then confirm the URL it was
given is fetchable with no credentials:

```bash
curl -I https://rustfs.example.com/mercur-media/some-image-01H.png
```

A `403` here means the bucket is not actually public — the upload worked, the URL
is stored, and every image will render broken until you fix the bucket policy.

#### Moving the files you already have

Switching only redirects *new* uploads. Everything uploaded before it keeps
serving from `/static`, which is why the `uploads` volume stays mounted. That is
a perfectly stable place to stop — storage is simply mixed.

To move the old files across as well:

```bash
# Report what would change. Copies nothing, changes nothing.
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup migrate-uploads

# Do it.
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup migrate-uploads --apply
```

What `--apply` does, in order:

1. takes a database backup, so the rewrite is one `restore` away from undone;
2. copies the files into the media bucket — the volume is mounted **read-only**,
   so the originals cannot be damaged;
3. fetches one of the copied files over plain HTTP and **stops if it is not
   publicly readable**, before touching a single row;
4. rewrites the stored URLs in one transaction across `image`, `media_image`,
   `product`, `product_variant`, `inventory_item`, `seller` (logo and banner),
   `user` and `order_claim_item_image`.

URLs are rewritten by file name, not by string-replacing the old host, so it
still works if your domain or scheme changed since those files were uploaded, and
running it twice is harmless.

Historical order snapshots (`cart_line_item.thumbnail`,
`order_line_item.thumbnail`) are deliberately left alone — they are a record of
what a past order looked like, not live catalogue data.

The originals stay on the volume afterwards. Leave them until you have clicked
through the panel and confirmed images render; only then is it safe to drop the
volume.

#### Two things to know

- **Deleting an old file after switching does not remove it from disk.** The
  delete is routed through the new provider, which does not have that key. The
  database row goes; the file is orphaned. Migrating first avoids this.
- **Videos work.** There is no mime-type restriction anywhere in the backend
  upload path — whatever the panel sends is stored. Any limit on *choosing* a
  video is in the panel's file picker, not here.

### Rolling back a deployment

Have this ready *before* you deploy, not after.

**Before you deploy anything, take a backup and write down where you are:**

```bash
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup once
git rev-parse --short HEAD    # or note the branch Dokploy is deploying
```

Then pick the rollback that matches what went wrong.

**The deploy failed and the site is down, but the data is fine.** Almost always
configuration. Fix the Environment tab and redeploy — you do not need to restore
anything. The usual suspects are in [Troubleshooting](#troubleshooting): a
missing `DOMAIN`, a `/` in `POSTGRES_PASSWORD`, `INSECURE_COOKIES` unset on http.

**The new code is wrong and you want the old code back.** In Dokploy, point the
service back at your previous branch or commit and **Rebuild**. Your data is
untouched: volumes are not part of the image, and rolling the code back does not
roll the database back.

One caveat that applies to *any* rollback, not just this one: **migrations are
one-way.** If the version you deployed added schema migrations, going back to
older code leaves it running against a newer schema. When the older code cannot
cope, restore the pre-deploy dump as well — which is why you take it first.

> For the specific rollback from this branch to `main`: it adds no migrations, so
> the schema is identical and a code-only rollback is clean. Two things to know
> anyway. `main` has the seed bug this branch fixes, so if you roll back with
> `RUN_SEED=true` its seed can crash-loop the container — set `RUN_SEED=false`
> before rolling back. (This branch writes the legacy
> `/app/static/.mercur-seeded` marker on a successful seed for exactly this
> reason, so in most cases `main` will skip seeding on its own.) And `main` does
> not understand `INSECURE_COOKIES`, so on plain http the panels go back to being
> unable to log in.

**The data is wrong — a bad migration, a bad script, a bad afternoon.** Restore
the dump you took before deploying:

```bash
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml stop backend worker
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup list
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup restore <the-dump-from-before>
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml start backend worker
```

Roll the code back **first** if the new code is what corrupted the data;
otherwise it will simply do it again to the restored database.

**Everything is gone and there is no backup.** There is no rollback. That is the
whole argument for the section above.

After any rollback, check the same three things:

```bash
curl -i https://YOUR-DOMAIN/health                      # 200
docker exec $(docker ps -qf name=postgres) psql -U mercur -d mercur \
  -c 'select name from store;' -c 'select count(*) from seller;'
```

and sign in to `/dashboard` — a healthcheck passing proves the server is up, not
that anyone can log in.

### Proving the backups actually restore

A backup nobody has restored is a hope, not a backup. `drill` restores the newest dump
into a throwaway database beside the real one, checks it came back readable, and drops
it again. The live database is never written to, so this is safe against production:

```bash
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml run --rm backup drill
```

```
[backup] drilling with the newest backup: mercur-20260904-063854Z.dump
[backup]   store: 1 (live 1)
[backup]   seller: 3 (live 3)
[backup]   product: 12 (live 12)
[backup]   offer: 203 (live 203)
[backup]   region: 1 (live 2 — drifted since the backup, expected on a busy site)
[backup] drill passed: mercur-20260904-063854Z.dump restores cleanly and the data is there.
```

It deliberately does **not** require the restored counts to equal the live ones. A backup
is a snapshot, so on any marketplace taking orders the newest dump is already behind by
the time it lands; a drill that failed on that would cry wolf daily and be switched off
within a week. Drift is printed for a human to eyeball. It fails only on the things that
actually mean your backups are broken: the dump not restoring, a table not coming back
readable, or a restore that carries the schema but none of the data.

**Run it monthly, and after any change to the database or the backup settings.**

### Surviving a service rename

Compose names volumes after the project: your database is really
`<project>_postgres-data`. Dokploy derives that project name from the service,
so **deleting and recreating the service, or renaming it, points the new stack at
a new empty volume** — the old one is still on disk, but nothing references it.
That is the most common way a marketplace "loses everything" on a redeploy when
the deploy itself was fine.

To decouple the data from the project name, give the volumes fixed names and
declare them external, so Compose fails loudly if they are missing instead of
quietly creating empty ones.

First, with the stack stopped, copy each volume to a fixed name:

```bash
docker compose -p YOUR-PROJECT -f deploy/docker-compose.yml down

for v in postgres-data redis-data uploads; do
  docker volume create "mercur-$v"
  docker run --rm -v "YOUR-PROJECT_$v":/from:ro -v "mercur-$v":/to alpine \
    sh -c 'cd /from && cp -a . /to/'
done
```

Then replace the `volumes:` block at the bottom of `deploy/docker-compose.yml`:

```yaml
volumes:
  postgres-data:
    name: mercur-postgres-data
    external: true
  redis-data:
    name: mercur-redis-data
    external: true
  uploads:
    name: mercur-uploads
    external: true
```

Deploy again and confirm your data is there before deleting the old volumes.

This is deliberately **not** the default: switching an existing deployment to
different volume names without copying the data first would start it against an
empty database — exactly the failure this avoids.

### Using a managed database

Set `DATABASE_URL` yourself and the bundled Postgres is ignored. Always include
an explicit `sslmode`, because Medusa turns database SSL on whenever
`NODE_ENV=production`:

```
DATABASE_URL=postgres://user:password@host:5432/mercur?sslmode=require
```

The bundled Postgres serves no TLS, which is why its URL uses `sslmode=disable`.
Omitting it makes migrations fail with a misleading "incorrect database URL".

### Adding the storefront

The Next.js storefront deploys separately. Add it as its own Dokploy application,
point `MEDUSA_BACKEND_URL` at this backend, and create a publishable API key in
the admin panel for `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`.

### Running it locally

The stack publishes no ports — on Dokploy, Traefik reaches the backend over the
`dokploy-network`, so `localhost:9000` is not bound. To try it on your own
machine you need a small override that publishes it:

```bash
docker network create dokploy-network        # once
cp deploy/.env.example deploy/.env           # then edit it

cat > deploy/docker-compose.local.yml <<'YAML'
services:
  backend:
    ports:
      - "9000:9000"
YAML

docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml \
  --env-file deploy/.env -p mercur up --build
```

Set `DOMAIN=localhost` and `MERCUR_BACKEND_URL=http://localhost:9000` in
`deploy/.env` for a local run, then open `http://localhost:9000/dashboard`.

The build context is the repository root, not this folder. Both `deploy/.env` and
`deploy/docker-compose.local.yml` are yours alone — do not commit them.

### Upgrading Mercur

Upgrades are a normal `git pull`. The one thing to re-check afterwards is the
config overlay:

```bash
diff -u packages/api/medusa-config.ts deploy/medusa-config.production.ts
```

The only differences should be the blocks marked `OVERLAY:` — Redis and
`workerMode`. If Mercur changed anything else in that file, copy the change
across and rebuild. If a future release adds Redis to the template itself, delete
the overlay and the `COPY deploy/medusa-config.production.ts` line from the
Dockerfile.

### What was tested

Run against Podman using the same command Dokploy issues:

| Test | Result |
|---|---|
| Missing `DOMAIN` stops the deploy before building | pass |
| Router answers 404 when no rule matches | pass |
| Image builds via Dokploy's exact command | pass |
| Panels served at `/dashboard/` and `/seller/`, assets 200 | pass |
| Origin compiled into the panels matches `MERCUR_BACKEND_URL` | pass |
| Worker starts only after the backend is healthy, runs no migrations | pass |
| Worker reuses the backend image — one build per deploy, not two | pass |
| `medusa user` writes both the `user` and `provider_identity` rows | pass |
| Login returns a token; a wrong password returns 401 | pass |
| Admin user survives a rebuild — same id, login still works | pass |
| Backend restart returns to healthy, login still works | pass |
| `down` + `up`: store, currencies, regions, sellers and products all survive | pass |
| Operator-added currency and region survive a redeploy | pass |
| Re-running the seed on a seeded database is a clean no-op | pass |
| Re-running the seed leaves an operator-added currency in place | pass |
| Re-running the seed leaves an operator-renamed store alone | pass |
| A failing seed logs a warning and the server still starts | pass |
| A `/` in `POSTGRES_PASSWORD` is rejected with an actionable message | pass |
| Admin lists all 3 demo sellers; each demo member sees only their own store | pass |
| `pg_dump` then `pg_restore --clean --if-exists` round-trips a live database | pass |
| Copying a volume to a fixed name preserves the database intact | pass |
| Over http with `INSECURE_COOKIES=false`, `/auth/session` sets no cookie | reproduced |
| With `INSECURE_COOKIES=true` the session cookie is set and accepted | pass |
| Admin panel: browser login, sidebar loads, Stores lists all 3 sellers | pass |
| Vendor Hub: browser login, store-select lists only the member's own store | pass |
| Store API serves the seeded catalog (12 products, 3 sellers, 203 offers) | pass |
| The worker connects to Redis and stays up alongside the backend | pass |
| Region, tax-region and category guards skip existing rows without duplicating | pass |
| A seed that fails midway leaves the site up and serving (0 restarts) | pass |
| A different image deployed over existing volumes keeps every row and upload | pass |
| A stock `.env.example`, filled in and nothing else, deploys and signs in | pass |
| `FILE_STORAGE` unset or `local` stores uploads on the volume, even with a bucket set | pass |
| `FILE_STORAGE=s3` missing a bucket, URL or credentials refuses to boot, naming each | pass |
| `FILE_STORAGE=nonsense` refuses to boot rather than falling back to local | pass |
| `FILE_STORAGE=s3` uploads images and video to RustFS, fetchable with no credentials | pass |
| Files uploaded before the switch keep serving from `/static` afterwards | pass |
| `migrate-uploads` dry run reports counts and changes nothing | pass |
| `migrate-uploads --apply` rewrites only this deployment's own files | pass |
| The seeded jsdelivr catalogue URLs survive the migration untouched | pass |
| A private media bucket aborts the migration with the database unchanged | pass |
| Re-running the migration finds nothing to do | pass |
| Both scripts are shellcheck-clean | pass |
| Migrations run unattended without stopping on a link-sync prompt | pass |
| Backup sidecar is absent unless `COMPOSE_PROFILES=backup` is set | pass |
| `backup check` reports a missing bucket instead of failing obscurely | pass |
| Scheduled backups land in RustFS and old ones are pruned | pass |
| Wrecked database fully restored from a RustFS dump | pass |
| S3 unreachable for two intervals: logs, retries, 0 restarts, self-recovers | pass |
| A not-yet-migrated database is skipped, not stored as an empty backup | pass |
| `backup drill` restores the newest dump to a scratch database and passes | pass |
| The drill reports post-backup drift without failing on it | pass |
| The legacy seed marker is written, so a rollback to `main` will not re-seed | pass |

Not verified locally: the router actually routing via the compose labels. The
labels and network attachment were confirmed on the container, but the local
Traefik could not read Podman's rootless socket and so discovered nothing. A real
Dokploy deployment serving `/health`, `/dashboard/` and `/seller/` is the proof.
