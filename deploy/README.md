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
```

Generate the three secrets by running this three times, using a different result
for each:

```bash
openssl rand -base64 48
```

Two warnings worth reading before you save.

**Set `POSTGRES_PASSWORD` once and never change it.** Postgres writes it into the
database on first start. Changing it later does not update the database, it just
locks your backend out — and the only fix is deleting the database volume, which
deletes your data.

**Start with `http://`, not `https://`.** You do not have a certificate yet.
Step 6 covers switching over once you do.

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
`http://api.example.com/dashboard`.

## Step 6 — switch on HTTPS

Once DNS resolves, Dokploy can obtain a Let's Encrypt certificate for your
domain. After `https://api.example.com/health` works:

1. Go back to the **Environment** tab
2. Change **every** `http://` to `https://` — that is `MERCUR_BACKEND_URL` and
   all four `*_CORS` values
3. Save, then click **Rebuild**

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

The upstream project is left untouched. Every deployment file lives in this
folder, so pulling a newer Mercur never conflicts with it. The production config
is applied as an overlay *inside the image only*, leaving
`packages/api/medusa-config.ts` exactly as Mercur ships it.

### Before you go live

- **Back up Postgres.** Your data lives in the `postgres-data` volume. Use
  Dokploy's backup schedule, or point `DATABASE_URL` at a managed database.
- **Uploads are on a local volume** at `/app/static`. They survive redeploys but
  cannot be shared across multiple backend replicas. Before scaling past one,
  switch to the S3 provider in `medusa-config.production.ts`.
- **Only `backend` runs migrations.** The worker deliberately does not, so two
  containers never migrate at once. Preserve that if you add services.
- **Redis is required.** Without it, in-flight workflow state is lost on every
  restart and the backend and worker cannot coordinate. Compose always sets it.
- **The worker is optional** for a small marketplace. Delete the `worker` service
  and set `MEDUSA_WORKER_MODE: shared` on `backend` to run everything in one
  process.
- **Demo data.** Set `RUN_SEED=true` before the first deploy for a demo catalog
  and seller (`seller@mercur.dev` / `supersecret`). It runs once; a marker on the
  uploads volume stops it repeating.

### Optional settings

`.env.example` documents a few settings the Step 3 block leaves out, each with a
working default: `DATABASE_URL` (below), `TRAEFIK_CERTRESOLVER` and
`TRAEFIK_ROUTER` (change the latter only if you run several of these stacks on
one host), `FILE_BACKEND_URL`, and the storefront hooks `MERCUR_VENDOR_URL`,
`STOREFRONT_REVALIDATE_URL` and `STOREFRONT_REVALIDATE_SECRET`.

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

```bash
docker network create dokploy-network        # once
cp deploy/.env.example deploy/.env           # then edit it
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build
```

The build context is the repository root, not this folder.

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
| `medusa user` writes both the `user` and `provider_identity` rows | pass |
| Login returns a token; a wrong password returns 401 | pass |
| Admin user survives a rebuild — same id, login still works | pass |
| Seeding does not repeat once the marker exists | pass |
| Backend restart returns to healthy, login still works | pass |

Not verified locally: the router actually routing via the compose labels. The
labels and network attachment were confirmed on the container, but the local
Traefik could not read Podman's rootless socket and so discovered nothing. A real
Dokploy deployment serving `/health`, `/dashboard/` and `/seller/` is the proof.
