# Development plan — Foundation, then Go-live

Status: **approved, not started**. Branch base: `feat/file-storage-s3` @ `dacbc27`.
See `PLAN-file-storage.md` for the storage work this builds on.

## Context

The deployment layer is now in good shape: data survives redeploys and upgrades, the
panels can log in, backups run to RustFS, uploads can live in object storage, and there is
a rollback runbook. None of that makes this a marketplace yet.

Two facts from the repo set the agenda:

- **It cannot take money.** No payment provider is configured; the seed wires regions to
  `pp_system_default`, a stub.
- **It cannot send email.** No notification provider is configured, so seller invites,
  password resets and order confirmations are generated and dropped.

And one fact explains why the last several sessions were so laborious: **there is one test
file** (`packages/api/integration-tests/http/health.spec.ts`) **and no CI**. Every fix was
verified by hand-driving Podman at roughly eight minutes per rebuild. Three of the bugs
found were ones introduced during the same session, caught only because the failure path
happened to get exercised. That does not scale and nothing stops a regression returning.

The good news: the test harness is already wired. `@medusajs/test-utils` provides
`medusaIntegrationTestRunner`, `packages/api/jest.config.js` already defines three modes
(`integration:http`, `integration:modules`, `unit`), and `integration-tests/setup.js`
exists. Adding tests is low-friction — nobody has done it.

**Stage 1 makes change safe. Stage 2 makes it a business.** In that order, because Stage 2
without Stage 1 means hand-verifying payment code, which is the worst place to be guessing.

---

# Stage 1 — Foundation

No credentials needed. Buildable start to finish today.

## 1a. Regression tests for what actually broke

Each of these corresponds to a real defect from this session. Two tiers, because these
bugs do not all live at the same level.

**Jest, in `packages/api` — fast, runs on every push:**

| Test | Guards against |
|---|---|
| Run the seed twice against one database | The non-idempotent seed that crash-looped the backend |
| Assert seed #2 leaves store name, `supported_currencies`, regions, tax regions and categories unchanged | The re-seed that silently reset store settings |
| Assert `/admin/sellers` returns all sellers and `/vendor/sellers` only the caller's | Locks in the "missing store" behaviour as *intended*, so nobody "fixes" it |

New files under `packages/api/integration-tests/http/`, following the existing
`health.spec.ts` shape. The seed is `packages/api/src/scripts/seed.ts` and takes
`{ container }`, so the runner's container can invoke it directly.

**Container smoke script — slower, runs on PR:**

Config guards and shell behaviour cannot be reached from jest: the production config is a
deploy-time overlay at `deploy/medusa-config.production.ts` (outside jest's `src/**`
`testMatch`), and the migration is SQL inside a shell script. These are fast to test at the
container level — loading the compiled config with different env took seconds when done by
hand:

```
docker run --rm --entrypoint node -e FILE_STORAGE=s3 <image> -e "require('/app/medusa-config.js')"
```

New file `deploy/smoke-test.sh`, asserting:

- `FILE_STORAGE` unset/`local`/`s3`-fully-configured load; `s3` missing any of bucket,
  public URL or credentials fails naming each; `nonsense` fails
- `INSECURE_COOKIES=true` over http produces a `Set-Cookie`; unset produces none
- `backup once` → `restore` round-trips a database
- `migrate-uploads` rewrites only this deployment's files and leaves CDN URLs alone
- a redeploy preserves store, sellers, products, offers and users

This is the manual suite I have been running by hand, written down.

## 1b. Core marketplace flow coverage

Integration tests over the flows you will actually customise later:

- **Seller lifecycle** — register → `pending_approval` → approve → `open`; suspend and
  reinstate
- **Catalogue** — vendor creates a product, admin approves it, vendor creates an offer
- **Multi-seller checkout** — cart with offers from two sellers → complete → one order
  group containing one order per seller
- **Scoping** — a vendor authenticated for seller A cannot read seller B's orders

The last one is a security property, not a feature; it deserves a test more than the rest.

## 1c. CI

New `.github/workflows/ci.yml`. Three jobs:

1. **Typecheck + lint** — `npm ci`, then **`npm run codegen` first** (it writes
   `packages/api/.mercur/routes.d.ts`; without it `check-types` fails with
   `Cannot find module '@acme/api/_generated'`), then `npm run check-types` and
   `npm run lint`.
2. **Tests** — Postgres and Redis service containers, populate the currently-empty
   `packages/api/.env.test` with `DATABASE_URL`/`REDIS_URL`, run all three jest modes.
3. **Container smoke** — build the image and run `deploy/smoke-test.sh`. Slow (~8 min), so
   scope it to pull requests rather than every push.

`package-lock.json` is committed, so `npm ci` is reproducible and cacheable.

## 1d. Restore drill

An untested backup is not a backup. Script the drill — dump, restore into a scratch
database, assert row counts match — and add it to `deploy/README.md` as a quarterly
routine. Reuses `backup.sh`'s existing `once` and `restore` modes.

---

# Stage 2 — Go-live

Needs credentials, but **not paid ones**: Stripe test-mode keys and a free email provider
tier unblock all of it, and both are available immediately.

## 2a. Stripe Connect — payments and payouts

Confirmed against Mercur's integration documentation:

- **Packages:** `@medusajs/medusa/payment-stripe` (already present via Medusa) and
  `@mercurjs/payout-stripe-connect` (new dependency in `packages/api/package.json`)
- **Payment module** — `@medusajs/medusa/payment`, provider
  `@medusajs/medusa/payment-stripe`, with `capture: false` (**required** for a marketplace)
  and `automatic_payment_methods: true`
- **Payout module** — `@mercurjs/core/modules/payout`, provider
  `@mercurjs/payout-stripe-connect`, with `accountValidation` controlling when connected
  accounts become `ACTIVE`
- **Env:** `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PAYOUT_WEBHOOK_SECRET`
- **Two webhooks**, with distinct signing secrets:
  - `/hooks/payment/stripe_stripe` — `payment_intent.succeeded`,
    `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`,
    `charge.refunded`
  - `/hooks/payout` — `account.updated`

Wired as `OVERLAY 5` in `deploy/medusa-config.production.ts`, following the
`FILE_STORAGE` pattern that already works: an explicit `PAYMENTS=stub|stripe` switch,
default `stub` so nothing changes until you opt in, and a boot guard that names every
missing variable rather than failing at checkout. The seed's `payment_providers:
["pp_system_default"]` needs the Stripe provider added to the region when enabled.

## 2b. Notifications — email

- **Provider:** `@medusajs/medusa/notification-sendgrid`, or Resend via Medusa's guide.
  `@medusajs/medusa/notification-local` logs to the terminal and is the right way to
  verify the wiring before any account exists.
- **Constraint:** only one provider per channel; `channels: ["email"]`.
- Same shape: `EMAIL_PROVIDER=none|local|sendgrid`, default `none`, guards on the rest.
- Then the templates that matter: seller invite, password reset, order confirmation.

## 2c. What is blocked, and what is not

| | |
|---|---|
| Buildable with no credentials | Both module wirings, the switches and guards, compose/env/README, `notification-local` verification |
| Needs Stripe test keys (free, immediate) | End-to-end checkout, webhook signature verification, payout onboarding |
| Needs an email account (free tier) | Real delivery |
| Needs live keys | Only the final production cutover |

---

## Files

| File | Stage | Change |
|---|---|---|
| `.github/workflows/ci.yml` | 1 | New — typecheck/lint, tests, container smoke |
| `packages/api/integration-tests/http/*.spec.ts` | 1 | New — seed idempotency, seller scoping, marketplace flows |
| `deploy/smoke-test.sh` | 1 | New — the manual suite, written down |
| `packages/api/.env.test` | 1 | Populate (currently empty) |
| `deploy/medusa-config.production.ts` | 2 | `OVERLAY 5` payments, `OVERLAY 6` notifications |
| `packages/api/package.json` | 2 | `@mercurjs/payout-stripe-connect` |
| `deploy/docker-compose.yml`, `.env.example`, `README.md` | 2 | Env pass-through and setup sections |
| `packages/api/src/scripts/seed.ts` | 2 | Add Stripe to region payment providers when enabled |

## Verification

- **Stage 1 is self-verifying** — that is the point. CI green on a pull request means
  typecheck, lint, all three jest modes and the container smoke script passed.
- Prove the tests actually bite: revert one of this session's fixes on a scratch branch
  (the seed guard is the easiest) and confirm CI goes red. A test suite nobody has seen
  fail is not yet evidence of anything.
- **Stage 2** — Stripe test mode end to end on the Podman stack: a two-seller cart through
  checkout, webhooks delivered via the Stripe CLI, an order group with a payment intent per
  seller, and a connected account reaching `ACTIVE`. Email verified first with
  `notification-local` in the logs, then for real.

## Risks

- **CI runtime.** The container smoke job is ~8 minutes. Keep it on pull requests only, or
  it will get disabled out of irritation.
- **Integration tests need a real Postgres.** They are slower and flakier than unit tests;
  `--runInBand` is already set, which matters.
- **`capture: false` is not optional** for a marketplace — capturing at authorisation
  breaks the payout split. Easy to miss, expensive to discover in production.
- **Do not batch this.** Land Stage 1 first and let CI prove itself before Stage 2 goes
  near payment code. The reason this work has held up so far is that each change was
  verified before the next one started.
