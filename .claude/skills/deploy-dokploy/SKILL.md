---
name: deploy-dokploy
description: Change anything under deploy/ — the Dokploy compose stack, the production config overlay, boot guards, backups, or the smoke suite. Use when adding a setting, a module, or a service to the deployment, or when a container behaves differently from local development.
---

# Deploying on Dokploy

`deploy/` is a self-contained production stack: a Dockerfile, a Compose file for Dokploy,
a production config overlay, a backup sidecar, and an end-to-end smoke suite.

| File | What it is |
|---|---|
| `docker-compose.yml` | `postgres`, `redis`, `backend`, `worker`, `backup` on `dokploy-network`, routed by Traefik |
| `medusa-config.production.ts` | The production config. Mirrors `packages/api/medusa-config.ts` with numbered `OVERLAY` blocks |
| `.env.example` | Every setting, documented |
| `README.md` | The operator-facing guide |
| `smoke-test.sh` | Boots a real stack and asserts against it. Pull requests only (~8 min) |

## The rule

**A setting, its documentation, and its assertion move in the same commit.** Several
defects in this project were documentation drifting away from behaviour, not code. If you
change a setting, change `deploy/README.md` and `deploy/.env.example` too, and add an
assertion to `deploy/smoke-test.sh` if the change has a failure mode worth catching.

## The overlay

`medusa-config.production.ts` is not upstream code. It is the development config plus
numbered blocks — `OVERLAY 1/6` through `6/6` — for Redis, worker mode, cookies, file
storage, email, and payments. Keep everything outside those blocks identical to
`packages/api/medusa-config.ts`, and renumber the whole set when you add one.

## Boot guards

Every optional integration follows the same shape: a switch with a safe default, a guard
that **refuses to boot** on an unrecognised value, and a guard that names *every* missing
variable at once.

```ts
if (!['none', 'local', 'resend'].includes(EMAIL_PROVIDER)) {
  throw new Error(`EMAIL_PROVIDER must be ... got "${EMAIL_PROVIDER}". Refusing to guess: ...`)
}
```

Two properties matter more than they look:

1. **Refuse rather than fall back.** Silently treating an unknown value as the default
   leaves a deployment that believes it sends email, or takes payments, and does neither.
2. **Name every missing variable, not the first.** An operator should need one deploy
   cycle to fix their config, not four.

Say *why* in the message. These strings are read by someone whose deploy just failed.

## The worker is a separate container

`backend` serves HTTP; `worker` runs subscribers, scheduled jobs, and the payout pipeline.
**Email is sent by the worker.** Any variable a subscriber reads must be in *both* service
blocks — adding it to `backend` only leaves the feature silently inert, and nothing else
in the suite notices. The smoke suite asserts worker environment for exactly this reason.

## Build-time versus runtime

`MERCUR_BACKEND_URL` is compiled into the panels at **build** time. Changing it needs a
rebuild, not a restart; a mismatch shows as a login page that fails with "Failed to
fetch". The same applies to any `NEXT_PUBLIC_*` in the storefront repo.

## Testing a config change without a full deploy

The smoke suite's cheapest tool requires the compiled config and reports whether it was
accepted — no database, no stack, about a second each:

```bash
docker run --rm --entrypoint node -e EMAIL_PROVIDER=nonsense "$IMAGE" \
  -e "try{require('/app/medusa-config.js');console.log('LOADED')}catch(e){console.log('REFUSED: '+e.message)}"
```

Locally, without building an image, transpile the overlay and require it — this executes
the guards, which a typecheck does not:

```bash
# from the repo root, with node_modules present
npx swc deploy/medusa-config.production.ts -o /tmp/cfg.js  # or @swc/core programmatically
```

`defineConfig` validates shape only. A wrong `resolve` string still "loads" and then fails
at boot, so check module paths separately with `require.resolve`.

## Backups

`backup once`, `restore <dump>`, `check`, `drill`, and `migrate-uploads`. The drill
restores the newest dump into a scratch database and verifies it is readable. It
deliberately does not compare against live counts — a snapshot is always behind, and a
check that cries wolf daily gets switched off.
