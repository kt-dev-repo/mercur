---
name: deploy-dokploy
description: Change anything under deploy/ or the deployment config overlay — the Dokploy compose stack, boot guards, backups, or the smoke suite. Use when adding a setting, a module, or a service to the deployment, or when a container behaves differently from local development.
---

# Deploying on Dokploy

`deploy/` is a self-contained production stack: a Dockerfile, a Compose file for Dokploy,
a backup sidecar, and an end-to-end smoke suite. The deployment *settings* live outside
it, in `packages/api/src/lib/production-overlay.ts`.

| File | What it is |
|---|---|
| `docker-compose.yml` | `postgres`, `redis`, `backend`, `worker`, `backup` on `dokploy-network`, routed by Traefik |
| `.env.example` | Every setting, documented |
| `README.md` | The operator-facing guide |
| `smoke-test.sh` | Boots a real stack and asserts against it. Pull requests only (~8 min) |

## The rule

**A setting, its documentation, and its assertion move in the same commit.** Several
defects in this project were documentation drifting away from behaviour, not code. If you
change a setting, change `deploy/README.md` and `deploy/.env.example` too, and add an
assertion to `deploy/smoke-test.sh` if the change has a failure mode worth catching.

## The overlay

Deployment settings — Redis, worker mode, cookie security, object storage, email,
payments — live in **`packages/api/src/lib/production-overlay.ts`**.
`packages/api/medusa-config.ts` is upstream's file plus two lines that delegate to it.

**Add new deployment settings to the overlay, never to `medusa-config.ts`.** The overlay
is an additive file, so an upstream change to their config can never conflict with it.
That is the whole point of the arrangement: `deploy/medusa-config.production.ts` used to
be a 419-line *copy* of the 83-line upstream config, and when upstream changed theirs the
copy silently kept the old version — a green build running configuration nobody wrote.

The overlay acts **only on variables that are explicitly set**. Unset means "leave the
base config alone", not "apply a production default" — which is what lets one file serve
both `npm run dev` and the container. `docker-compose.yml` always passes
`EMAIL_PROVIDER`, `FILE_STORAGE`, `PAYMENTS` and `MEDUSA_WORKER_MODE` explicitly, with
defaults of its own.

Two consequences worth knowing:

- A setting that is only meaningful in production still needs a sensible "unset" branch,
  or development changes behaviour the moment you add it.
- Running the image without Compose and without `EMAIL_PROVIDER` leaves the development
  notification provider in place, which logs mail rather than dropping it.

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

Locally, without building an image, register a `.ts` require hook and require the config
directly — this executes the guards, which a typecheck does not:

```js
const { transformFileSync } = require("@swc/core");
require.extensions[".ts"] = (mod, f) =>
  mod._compile(transformFileSync(f, {
    jsc: { parser: { syntax: "typescript" } }, module: { type: "commonjs" },
  }).code, f);
require("./packages/api/medusa-config.ts");
```

**Verify a config change by comparing behaviour, not by reading it.** Dump the fully
normalised object `withMercur` returns across an environment matrix — every combination
of the settings, plus each refusal — and diff old against new with keys sorted, since key
order varies and means nothing. That is how the overlay inversion was shown to be
identical in 18 of 18 compose-faithful environments.

`defineConfig` validates shape only. A wrong `resolve` string still "loads" and then fails
at boot, so check module paths separately with `require.resolve`.

## Backups

`backup once`, `restore <dump>`, `check`, `drill`, and `migrate-uploads`. The drill
restores the newest dump into a scratch database and verifies it is readable. It
deliberately does not compare against live counts — a snapshot is always behind, and a
check that cries wolf daily gets switched off.
