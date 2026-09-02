# Deploying Mercur on Dokploy

This repo is a Mercur marketplace project (the `templates/basic` layout that
`bun create mercur-app` produces) with a production Docker setup added.

**The upstream project tree is unmodified.** Every deployment file lives in this
`deploy/` directory, so `git pull` and future Mercur upgrades never conflict with
it. The one production config change (Redis + worker mode) is kept as an overlay
in `deploy/medusa-config.production.ts` and copied over
`packages/api/medusa-config.ts` *inside the image only* — see
[Upgrading](#upgrading-mercur).

One container serves everything:

| Path | What |
|---|---|
| `/store`, `/admin`, `/vendor`, `/auth` | Medusa + Mercur APIs |
| `/dashboard` | Admin panel (marketplace operator) |
| `/seller` | Vendor panel (sellers) |
| `/static` | Uploaded files (local file provider) |

## What's in here

| File | Purpose |
|---|---|
| `deploy/Dockerfile` | Two-stage build: `bun install` + `turbo run build` → `packages/api/.medusa/server` artifact on a slim Node 22 runtime |
| `deploy/entrypoint.sh` | Waits for Postgres, runs `medusa db:migrate`, optionally seeds, then `medusa start` |
| `deploy/docker-compose.yml` | Postgres 16 + Redis 7 + backend + worker, wired to Dokploy's Traefik network |
| `deploy/medusa-config.production.ts` | Config overlay: adds the Redis modules + `workerMode`. Applied only inside the image |
| `deploy/.env.example` | Every variable you need to paste into Dokploy |
| `.dockerignore` | Repo root, because the build context is the repo root |

## Step 1 — push this to your own Git repo

Dokploy deploys from Git, so this needs to be a repo you control:

```bash
cd mercur-dokploy && git init && git add -A && git commit -m "Mercur marketplace + Dokploy deploy setup"
```

Then add your remote and push.

## Step 2 — create the Compose service in Dokploy

1. **Project → Create Service → Compose**
2. **Provider**: your Git repo, branch `main`
3. **Compose Path**: `./deploy/docker-compose.yml`

## Step 3 — set the environment

Copy `deploy/.env.example` into the service's **Environment** tab and fill it in.
Dokploy writes that tab to `deploy/.env` in the checkout and passes it to compose
as `--env-file`, so these values drive both interpolation and build arguments.

A minimal working set, for a host that does not have TLS yet:

```
DOMAIN=api.example.com
MERCUR_BACKEND_URL=http://api.example.com
JWT_SECRET=...
COOKIE_SECRET=...
POSTGRES_PASSWORD=...
STORE_CORS=http://api.example.com
ADMIN_CORS=http://api.example.com
VENDOR_CORS=http://api.example.com
AUTH_CORS=http://api.example.com
```

Switch every `http://` above to `https://` once the certificate is issued, and
**Rebuild** — `MERCUR_BACKEND_URL` is compiled into the panels.

If `DOMAIN` is missing the deploy stops immediately with
`required variable DOMAIN is missing a value`. That is deliberate: a blank
`Host()` rule would give Traefik a router that matches nothing, which looks
exactly like the 404 described under [Troubleshooting](#troubleshooting).

Generate the secrets with:

```bash
openssl rand -base64 48
```

Run that three times — `JWT_SECRET`, `COOKIE_SECRET` and `POSTGRES_PASSWORD` must
each be different.

`MERCUR_BACKEND_URL` must be the exact public https origin you will attach in
Step 4, with no trailing slash. It is compiled into the admin and vendor panels
at image build time — if you change it later you must **Rebuild**, not just
restart, or the panels will keep calling the old origin from the browser.

## Step 4 — attach the domain

Set `DOMAIN` in the environment to the bare hostname (no scheme, no trailing
slash). The compose file turns it into Traefik router labels on the `backend`
service, and attaches that service to the external `dokploy-network`.

**Both parts are required.** Being on `dokploy-network` only makes the container
reachable; without a router rule Traefik has no route for the host and answers
every request with its own plain-text `404 page not found`. If you see that,
`DOMAIN` is unset or the labels did not apply — check `docker inspect` on the
backend container for `traefik.http.routers.*`.

You can also add the domain in Dokploy's **Domains** tab (`backend`, port 9000).
That is redundant with the labels but harmless — Traefik ends up with two routers
pointing at the same service.

## Step 5 — first deploy

Set `RUN_SEED=true` **for the first deploy only** if you want the demo catalog
and the demo seller (`seller@mercur.dev` / `supersecret`). Then hit **Deploy**.

The first build pulls the full Medusa dependency tree and builds both panels —
expect roughly 10–20 minutes and give the server at least 4 GB of RAM. Later
builds reuse the Docker layer cache.

When it finishes, set `RUN_SEED` back to `false` and redeploy so the seed does
not run again.

## Step 6 — create your admin user

From the service's **Terminal** (or `docker exec` on the host), on the `backend`
container:

```bash
cd /app && npx medusa user -e you@example.com -p 'a-strong-password'
```

The `cd /app` is required. Some terminals (Dokploy's included) drop you in `/`,
and `npx` resolves binaries from the current directory's `node_modules` — from
`/` it fails with `npm error could not determine executable to run`. There is no
`sudo` in the image and none is needed; it runs as the unprivileged `node` user,
which owns the app.

Then sign in at `https://your-domain/dashboard`. Sellers register and sign in at
`https://your-domain/seller`.

## Troubleshooting

**Traefik's plain-text `404 page not found` on every path.** No router matches the
host. `DOMAIN` is unset, does not match the hostname you are opening, or the
stack was deployed before the Traefik labels existed. Redeploy with `DOMAIN` set.

**The login page renders, then "Failed to fetch" on submit.** The panels call the
origin baked in at build time, and it does not match the origin in your address
bar — usually `https://` baked while you browse `http://`, or vice versa. Fix
`MERCUR_BACKEND_URL` so the scheme and host match exactly, then **Rebuild**
(a restart is not enough, the value is compiled into the JS bundle). Confirm what
was baked with:

```bash
curl -s https://your-domain/dashboard/ | grep -o '/dashboard/assets/index-[^"]*\.js'
curl -s https://your-domain/dashboard/assets/index-XXXX.js | grep -oE 'https?://[a-zA-Z0-9._:-]+' | sort -u
```

**Worker sits in `Created` and never starts.** It gates on `backend` reporting
healthy. If the backend never becomes healthy, check its logs — on first boot
migrations can take minutes, which is why `start_period` is 600s.

## Things worth knowing before you go live

**Uploads are on a local volume.** The default file provider writes to the
`uploads` volume at `/app/static`. It survives redeploys, but it does not survive
moving to another host and it cannot be shared across replicas. Before scaling
the `backend` service past one instance, switch to the S3 provider in
`deploy/medusa-config.production.ts`.

**Migrations run from `backend` only.** `RUN_MIGRATIONS` is deliberately not set
on `worker`, so two containers never migrate the same database at once. Keep it
that way if you add more services.

**Redis is required in production.** The upstream `packages/api/medusa-config.ts`
registers no Redis modules at all. `deploy/medusa-config.production.ts` adds them
(cache, event bus, workflow engine, locking) whenever `REDIS_URL` is set, and
compose always sets it. Without Redis, in-flight workflow state is lost on every
restart and the server and worker cannot coordinate.

**The worker is optional.** For a small marketplace you can delete the `worker`
service and set `MEDUSA_WORKER_MODE: shared` on `backend`; one process then
handles both HTTP and jobs.

**Database SSL.** Medusa turns database SSL on whenever `NODE_ENV=production`.
The bundled Postgres serves no TLS, so its `DATABASE_URL` carries
`?sslmode=disable` — without it the connection stalls until Medusa's 10s timeout
and migrations fail with a misleading "incorrect database URL" error. If you
point `DATABASE_URL` at a managed database instead, use `?sslmode=require`.

**Postgres backups are yours to configure.** The database lives in the
`postgres-data` volume. Set up Dokploy's backup schedule, or point
`DATABASE_URL` at a managed Postgres instead of the bundled service.

**CORS.** The panels are served from the backend's own origin, so
`MERCUR_BACKEND_URL` must appear in `ADMIN_CORS`, `VENDOR_CORS` and `AUTH_CORS`.
Your storefront origin goes in `STORE_CORS` and `AUTH_CORS`.

## Adding the storefront later

The Next.js storefront is a separate deployable. Add it as its own Dokploy
application (Nixpacks or a Dockerfile), point `MEDUSA_BACKEND_URL` at this
backend, and create a publishable API key in the admin panel for
`NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`.

## Testing the image locally

```bash
docker build -f deploy/Dockerfile --build-arg MERCUR_BACKEND_URL=http://localhost:9000 -t mercur-backend .
```

Note the context is the repo root, not `deploy/`. Or bring the whole stack up:

```bash
cp deploy/.env.example deploy/.env && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build
```

(Local runs need `docker network create dokploy-network` once, since the compose
file expects that network to already exist on a Dokploy host.)

## Verified

This setup was built and run end to end before you got it:

- image builds clean, 811MB
- both panels bundled into the artifact at `/dashboard` and `/seller`, with their
  asset base paths validated by `bundle-dashboards.mjs` in production mode
- `docker compose up` → migrations run, `GET /health` returns 200
- `/dashboard/` and `/seller/` return 200 and their JS bundles load
- `backend` starts in `server` mode, `worker` in `worker` mode, and the worker
  does not run migrations
- `cd /app && npx medusa user ...` creates an admin, and that admin can then
  authenticate against `POST /auth/user/emailpass`

## Upgrading Mercur

Nothing here touches the upstream tree, so upgrades are a normal `git pull` (or a
re-scaffold from a newer `bun create mercur-app`). The single thing to re-check
afterwards is the config overlay:

```bash
diff -u packages/api/medusa-config.ts deploy/medusa-config.production.ts
```

The only differences should be the two blocks marked `OVERLAY:` — the Redis
modules and `workerMode`. If upstream changed anything else in that file, copy
the change across, then rebuild.

If a future Mercur release adds Redis modules to the template itself, delete the
overlay and the `COPY deploy/medusa-config.production.ts` line in
`deploy/Dockerfile`.
