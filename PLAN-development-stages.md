# Development plan — Foundation, then Go-live

Status: **Stage 1 — 19 of 20 done; Stage 2 — 7 of 15, email done.** Based on `main`.
See `PLAN-file-storage.md` for the storage work this builds on.

Stage 1 landed so far: regression tests for the seed and seller scoping, GitHub Actions
running typecheck/lint and three jest suites, a container smoke suite on
pull requests, a backup restore drill, and flow coverage of the seller lifecycle and the
product approval pipeline. Remaining: multi-seller checkout.

Stage 2b — email — is **done**. Seller invitation email goes out through Resend, real
delivery is proven end to end against the live API rather than mocked, and the integration
has since been reviewed and hardened against the failure modes that review found. What
remains in Stage 2 is Stripe (2a, needs test keys) and the two emails nobody has written
yet: password reset and order confirmation.

## Context

The deployment layer is now in good shape: data survives redeploys and upgrades, the
panels can log in, backups run to RustFS, uploads can live in object storage, and there is
a rollback runbook. None of that makes this a marketplace yet.

Two facts from the repo set the agenda:

- **It cannot take money.** No payment provider is configured; the seed wires regions to
  `pp_system_default`, a stub.
- **It cannot send email.** No notification provider is configured, so seller invites,
  password resets and order confirmations are generated and dropped.
  *Resolved for the seller invitation (2b); password reset and order confirmation still
  have no subscriber.*

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
Progress: **19 / 20**

## 1a. Regression tests for what actually broke

Each maps to a real defect from this session. Two tiers, because these bugs do not all
live at the same level.

**Jest, in `packages/api` — fast, runs on every push:**

- [x] Seed runs twice against one database without failing
- [x] Second seed leaves store name and `supported_currencies` unchanged
- [x] Second seed creates no duplicate regions, tax regions or categories
- [x] `/admin/sellers` returns every seller; `/vendor/sellers` returns only the caller's
      — locks in the "missing store" behaviour as *intended*

**Container smoke script (`deploy/smoke-test.sh`) — slower, runs on PR:**

Config guards and shell behaviour cannot be reached from jest: the production config is a
deploy-time overlay outside jest's `src/**` `testMatch`, and the migration is SQL inside a
shell script. Both are fast to check at container level.

- [x] `FILE_STORAGE` unset / `local` / fully-configured `s3` all load
- [x] `s3` missing bucket, public URL or credentials fails, naming each one
- [x] `FILE_STORAGE=nonsense` refuses to boot
- [x] `INSECURE_COOKIES=true` over http yields a `Set-Cookie`; unset yields none
- [x] `backup once` → `restore` round-trips a database
- [x] `migrate-uploads` rewrites only this deployment's files, leaving CDN URLs alone
- [x] A redeploy preserves store, sellers, products, offers and users

## 1b. Core marketplace flow coverage

- [x] Seller lifecycle — register → `pending_approval` → approve → `open`; suspend, reinstate
- [x] Catalogue — vendor creates a product, admin approves, vendor creates an offer
- [ ] Multi-seller checkout — two sellers in one cart → one order group, one order each
- [x] **Scoping** — a vendor authenticated for seller A cannot read seller B's orders
      (a security property, not a feature)

## 1c. CI

- [x] `.github/workflows/ci.yml` — job 1: `npm ci` → **`npm run codegen` first** → `check-types` → `lint`
- [x] Job 2: Postgres + Redis services, populate the empty `packages/api/.env.test`, run all three jest modes
- [x] Job 3: build the image and run `deploy/smoke-test.sh` — **pull requests only** (~8 min)

## 1d. Restore drill and proof

- [x] Script the drill: `backup.sh drill` restores the newest dump into a scratch database
      and verifies it came back readable; documented in `deploy/README.md`.
      *Does not compare against live counts — a snapshot is always behind, and a check
      that cries wolf daily gets switched off.*
- [x] **Prove the tests bite** — revert one fix on a scratch branch, confirm CI goes red.
      *Done: `scratch/prove-tests-bite` restored main's seed; CI failed with
      "Product category with handle: sandals, already exists." Branch deleted.*

---

# Stage 2 — Go-live

Needs credentials, but **not paid ones**: Stripe test-mode keys and a free email tier
unblock all of it, and both are available immediately.
Progress: **7 / 15**

## 2a. Stripe Connect — payments and payouts

Confirmed against Mercur's integration documentation, not recalled.

- [ ] Add `@mercurjs/payout-stripe-connect` to `packages/api/package.json`
- [ ] Payment module — `@medusajs/medusa/payment` + `@medusajs/medusa/payment-stripe`,
      with **`capture: false`** (mandatory for a marketplace) and `automatic_payment_methods: true`
- [ ] Payout module — `@mercurjs/core/modules/payout` + `@mercurjs/payout-stripe-connect`,
      with `accountValidation`
- [ ] `PAYMENTS=stub|stripe` switch, default `stub`, boot guard naming every missing variable
- [ ] Seed: add the Stripe provider to region `payment_providers` when enabled
- [ ] Webhooks — `/hooks/payment/stripe_stripe` (`payment_intent.succeeded`,
      `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`,
      `charge.refunded`) and `/hooks/payout` (`account.updated`), distinct signing secrets
- [ ] Verify in Stripe test mode: two-seller cart → checkout → order group with a payment
      intent per seller; connected account reaches `ACTIVE`

## 2b. Notifications — email

Resend rather than SendGrid, chosen when this was scoped.

- [x] `EMAIL_PROVIDER=none|local|resend` switch, default `none`; `channels: ["email"]`
      (only one provider per channel), with boot guards naming every missing variable
- [x] A Resend provider at `packages/api/src/modules/resend/`. Talks to the REST API with
      `fetch` and has **no dependencies** — the `resend` SDK peer-depends on react 19,
      which conflicts with the pinned react 18.3.1 and breaks the runtime artifact install
- [x] **The missing subscriber.** Mercur emits `member_invite.created` and has a step that
      knows how to send, but nothing connects them and no route calls the workflow that
      does. Inviting a seller returned 201 and told nobody
- [x] Verified: 9 unit tests, an integration test asserting the notification reaches
      `status: "success"` (it fails with `"failure"` when no provider is configured), and
      the `EMAIL_PROVIDER` boot guards in the smoke suite
- [x] **Hardened after a review of the live integration** (2026-09-05). Five defects, all
      of the same family — the thing fails and nobody finds out:
      - The address, the URL and the store name are escaped before they enter the markup.
        None of the three is trusted input
      - A failed send is recorded on the invite's `metadata` (`email_delivery`,
        `email_error`, `email_failed_at`). It is still not rethrown — a failed email must
        not roll back a valid invite — but a log line alone was invisible, and the
        operator saw 201 and assumed the seller had been told
      - Three attempts on 429, 5xx and transport failures, honouring `Retry-After`. Resend
        allows ~2 requests/second, so inviting a team hit a 429 that nobody retried. A 4xx
        still fails at once: a rejection will reject again
      - Deduplicated twice over — the notification module's unique `idempotency_key` makes
        a second row impossible, and the provider sends an `Idempotency-Key` for anything
        that gets past it. Keyed on the invite id, which is safe because a resend deletes
        the invite and creates a new one
      - The email names the inviting store, in the subject and the body, and states the
        expiry date. It previously read "An invitation has been sent to <address>" —
        third person, naming nobody, indistinguishable from spam
      - `validateOptions` checks the shape of `from`, not just its presence; recipients
        are masked in provider logs
- [x] **Real delivery through Resend** — done 2026-09-05 against a verified domain. The
      full path, on the deploy stack rather than in a test: admin creates a seller,
      `POST /admin/sellers/:id/members/invite` returns 201, `member_invite.created`
      reaches the subscriber **in the worker container**, and Resend returns a message id.
      Creating a seller with a `member` invites that address too, so both trigger paths
      deliver
- [x] Coverage: 29 unit tests (from 9), 10 integration, 19 module. The integration test
      asserts `data.seller_name` reaches the notification — `content` is not persisted by
      the notification module — which is what proves the seller lookup resolves rather
      than failing soft into an anonymous email
- [ ] Password reset and order confirmation. Neither exists: Medusa emits the events,
      nothing listens, so each needs its own subscriber and template. The seller invitation
      is the only email in the system

## 2c. What is blocked, and what is not

| | |
|---|---|
| Buildable with no credentials | Both module wirings, switches and guards, compose/env/README, `notification-local` verification |
| Needs Stripe test keys (free, immediate) | End-to-end checkout, webhook signatures, payout onboarding |
| ~~Needs an email account (free tier)~~ | Real delivery — **done**, verified 2026-09-05 |
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
