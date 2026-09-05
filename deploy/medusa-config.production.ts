// ---------------------------------------------------------------------------
// PRODUCTION OVERLAY — not upstream code, and not used in development.
//
// deploy/Dockerfile swaps this in for packages/api/medusa-config.ts *inside the
// image only*. The upstream file stays untouched in Git so `git pull` / template
// upgrades never conflict.
//
// It is a copy of the upstream config plus exactly five additions, each marked
// with "OVERLAY:" below:
//   1. the Redis-backed cache / event bus / workflow engine / locking modules
//   2. `workerMode`, so the server and worker containers can be split
//   3. an opt-out from Secure session cookies, for http-only deployments
//   4. S3-compatible object storage for uploads, when a bucket is configured
//   5. a notification provider, so the marketplace can actually send email
//
// >>> WHEN YOU UPGRADE MERCUR, RE-SYNC THIS FILE. <<<
//   diff -u packages/api/medusa-config.ts deploy/medusa-config.production.ts
// Everything except the OVERLAY blocks should be identical.
// ---------------------------------------------------------------------------
import { loadEnv } from '@medusajs/framework/utils'
import { withMercur } from '@mercurjs/core'
import fs from 'fs'
import path from 'path'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// Resolves where a dashboard app lives:
// - in the source tree (development): ../../apps/<name>
// - in the production build artifact: hosts that deploy only `.medusa/server` (for example
//   Medusa Cloud) get the panels bundled into ./dashboards/<name> by
//   scripts/bundle-dashboards.mjs during `build`. The compiled config runs from the
//   artifact root, so __dirname points there.
const dashboardAppDir = (name: string) => {
  const bundled = path.join(__dirname, 'dashboards', name)
  return fs.existsSync(bundled) ? bundled : path.join(__dirname, `../../apps/${name}`)
}

// OVERLAY 1/6 — Redis.
// Required in production: the in-memory workflow engine loses in-flight workflow
// state on every restart and cannot be shared between the server and worker
// containers. Registered only when REDIS_URL is set, so this file still runs
// without Redis if you ever build it locally.
const REDIS_URL = process.env.REDIS_URL

const redisModules = REDIS_URL
  ? [
      {
        resolve: '@medusajs/medusa/cache-redis',
        options: { redisUrl: REDIS_URL },
      },
      {
        resolve: '@medusajs/medusa/event-bus-redis',
        options: { redisUrl: REDIS_URL },
      },
      {
        resolve: '@medusajs/medusa/workflow-engine-redis',
        // This module logs "The `url` option is deprecated. Please use `redisUrl`
        // instead" on every boot. Do not act on it: at @medusajs/medusa 2.18.0 the
        // loader still destructures `options.redis.url`, so moving to `redisUrl`
        // crashes the whole server with "Cannot destructure property 'url' of
        // '(intermediate value)' as it is undefined". The warning is cosmetic;
        // revisit it only after a Medusa upgrade.
        options: { redis: { url: REDIS_URL } },
      },
      {
        resolve: '@medusajs/medusa/locking',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/locking-redis',
              id: 'locking-redis',
              is_default: true,
              options: { redisUrl: REDIS_URL },
            },
          ],
        },
      },
    ]
  : []

// OVERLAY 3/6 — session cookie security.
// Medusa's express-loader hardcodes `secure: true` on the session cookie whenever
// NODE_ENV is production or staging, and express-session then silently declines to
// send Set-Cookie on a request it does not consider secure. The symptom is precise
// and baffling: POST /auth/session answers 200 with the user payload, no cookie is
// stored, and the panel bounces straight back to its login screen. No error anywhere.
//
// Behind Dokploy's Traefik with a certificate this is correct and needs nothing —
// Traefik sends X-Forwarded-Proto: https and Medusa already trusts the proxy.
// Set INSECURE_COOKIES=true ONLY while the site is served over plain http: the
// window before your certificate is issued, or a local run. Session cookies then
// travel unencrypted and can be read off the network, so turn it back off — and
// rebuild — the moment https works.
const INSECURE_COOKIES = process.env.INSECURE_COOKIES === 'true'

// OVERLAY 4/6 — where uploaded files live.
// FILE_STORAGE picks the provider for every upload: product images and videos,
// seller logos and banners, anything a block adds later.
//
//   local (default)  the `uploads` volume at /app/static, exactly as upstream
//   s3               S3-compatible object storage — RustFS, AWS S3, R2, B2, Spaces
//
// It is one or the other for the whole deployment, not a per-upload choice:
// @medusajs/file refuses to boot with more than one provider registered
// ("File module should be initialized with exactly one provider").
//
// Switching only changes where NEW uploads go. Stored URLs are absolute, so files
// already uploaded keep resolving from wherever they were written — which is why
// the uploads volume stays mounted after moving to s3. To move the old files
// across as well, run `backup.sh migrate-uploads`; see deploy/README.md.
//
// @medusajs/file-s3 ships with Medusa; there is nothing to install.
const FILE_STORAGE = process.env.FILE_STORAGE || 'local'

if (FILE_STORAGE !== 'local' && FILE_STORAGE !== 's3') {
  throw new Error(
    `FILE_STORAGE must be "local" or "s3", got "${FILE_STORAGE}". ` +
      'Refusing to guess: quietly falling back to local here would write uploads to a ' +
      'container volume you did not intend to depend on.'
  )
}

if (FILE_STORAGE === 's3') {
  // Checked here rather than left to the provider, because the failure is silent
  // rather than loud. The provider builds every public URL as `${file_url}/${key}`,
  // so a missing file_url stores every image as "undefined/foo.png" — the upload
  // reports success and the entire catalogue renders broken.
  const missing = [
    !process.env.S3_FILE_BUCKET && 'S3_FILE_BUCKET',
    !process.env.S3_FILE_PUBLIC_URL && 'S3_FILE_PUBLIC_URL',
    !process.env.S3_ACCESS_KEY_ID && 'S3_ACCESS_KEY_ID',
    !process.env.S3_SECRET_ACCESS_KEY && 'S3_SECRET_ACCESS_KEY',
  ].filter(Boolean)

  if (missing.length) {
    throw new Error(
      `FILE_STORAGE=s3 but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'S3_FILE_PUBLIC_URL is the address that serves the bucket to a browser, ' +
        'e.g. https://rustfs.example.com/mercur-media'
    )
  }
}

// OVERLAY 5/6 — sending email.
// Without a notification provider the marketplace cannot send anything, and the failure
// is silent rather than loud: Mercur's seller invitation builds its email, hands it to
// the notification module, and it goes nowhere. The invite is created, the API returns
// success, and the person is simply never told.
//
//   none (default)  no provider, exactly as before
//   local           logs to the terminal — verifies the whole path with no account
//   resend          real delivery through Resend
//
// One provider per channel is a Medusa constraint, so this is a choice, not a stack.
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'none'

if (!['none', 'local', 'resend'].includes(EMAIL_PROVIDER)) {
  throw new Error(
    `EMAIL_PROVIDER must be "none", "local" or "resend", got "${EMAIL_PROVIDER}". ` +
      'Refusing to guess: falling back to none here would leave email silently undelivered, ' +
      'which is the exact failure this setting exists to fix.'
  )
}

if (EMAIL_PROVIDER === 'resend') {
  const missing = [
    !process.env.RESEND_API_KEY && 'RESEND_API_KEY',
    !process.env.RESEND_FROM && 'RESEND_FROM',
  ].filter(Boolean)

  if (missing.length) {
    throw new Error(
      `EMAIL_PROVIDER=resend but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'RESEND_FROM must be an address on a domain verified in your Resend account; until you ' +
        'verify one, only onboarding@resend.dev works and it can only reach the account owner.'
    )
  }
}

const notificationModules =
  EMAIL_PROVIDER === 'none'
    ? []
    : [
        {
          resolve: '@medusajs/medusa/notification',
          options: {
            providers: [
              EMAIL_PROVIDER === 'resend'
                ? {
                    // Resolved from the build artifact, where `medusa build` compiles
                    // src/ to the same relative path.
                    resolve: './src/modules/resend',
                    id: 'resend',
                    options: {
                      channels: ['email'],
                      api_key: process.env.RESEND_API_KEY,
                      from: process.env.RESEND_FROM,
                      reply_to: process.env.RESEND_REPLY_TO,
                    },
                  }
                : {
                    resolve: '@medusajs/medusa/notification-local',
                    id: 'local',
                    options: { channels: ['email'] },
                  },
            ],
          },
        },
      ]

// OVERLAY 6/6 — taking money, and paying sellers.
// A marketplace that cannot charge a customer is a catalogue. The seed wires regions to
// `pp_system_default`, a stub that authorises nothing, so out of the box checkout
// completes without money moving.
//
//   stub (default)  pp_system_default only — no real charges, safe for a demo
//   stripe          real card payments AND Stripe Connect payouts to sellers
//
// Comma-separated on purpose. Medusa allows several payment providers per region, and
// Stripe does not acquire everywhere — Cambodia needs ABA PayWay, for instance (see
// PLAN-aba-payway-khqr.md). Adding a second provider should be a config change, not a
// rewrite of this block.
const PAYMENTS = (process.env.PAYMENTS || 'stub')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)

const KNOWN_PAYMENTS = ['stub', 'stripe']
const unknownPayments = PAYMENTS.filter((p) => !KNOWN_PAYMENTS.includes(p))

if (unknownPayments.length) {
  throw new Error(
    `PAYMENTS contains ${unknownPayments.map((p) => `"${p}"`).join(', ')}, which ` +
      `${unknownPayments.length > 1 ? 'are' : 'is'} not recognised. ` +
      `Valid values are ${KNOWN_PAYMENTS.join(', ')}, comma-separated. ` +
      'Refusing to guess: silently ignoring an unknown provider would leave the ' +
      'marketplace taking no money while appearing to be configured for it.'
  )
}

const STRIPE_ENABLED = PAYMENTS.includes('stripe')

if (STRIPE_ENABLED) {
  const missing = [
    !process.env.STRIPE_API_KEY && 'STRIPE_API_KEY',
    !process.env.STRIPE_WEBHOOK_SECRET && 'STRIPE_WEBHOOK_SECRET',
    !process.env.STRIPE_PAYOUT_WEBHOOK_SECRET && 'STRIPE_PAYOUT_WEBHOOK_SECRET',
  ].filter(Boolean)

  if (missing.length) {
    throw new Error(
      `PAYMENTS includes stripe but ${missing.join(', ')} ` +
        `${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'The payment and payout webhooks are two separate Stripe endpoints with two ' +
        'different signing secrets — combining them means one of the two silently ' +
        'fails signature verification and those events are lost.'
    )
  }
}

// Payments and payouts are two different Stripe integrations, not one. The payment
// provider charges the customer; the payout provider transfers each seller their share
// afterwards. Mercur uses Stripe's separate charges and transfers model, which makes the
// platform the merchant of record.
const paymentModules = !STRIPE_ENABLED
  ? []
  : [
      {
        resolve: '@medusajs/medusa/payment',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/payment-stripe',
              id: 'stripe',
              options: {
                apiKey: process.env.STRIPE_API_KEY,
                webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
                // NOT optional for a marketplace, and the easiest thing here to get
                // wrong. Capturing at authorisation takes the whole amount immediately,
                // before the split is known, which breaks the payout to sellers. The
                // payout module captures later, once fulfilment allows it.
                capture: false,
                // `automaticPaymentMethods`, camelCase — NOT the
                // `automatic_payment_methods` Mercur's Stripe Connect guide shows. The
                // installed provider reads the camelCase key
                // (payment-stripe/dist/core/stripe-base.js) and ignores the snake_case
                // one silently, so the documented spelling leaves the intent without
                // automatic payment methods while looking configured. Verified against
                // 2.18.0; check this again on upgrade.
                automaticPaymentMethods: true,
              },
            },
          ],
        },
      },
      {
        resolve: '@mercurjs/core/modules/payout',
        options: {
          providers: [
            {
              resolve: '@mercurjs/payout-stripe-connect',
              id: 'stripe-connect',
              options: {
                apiKey: process.env.STRIPE_API_KEY,
                // A DIFFERENT secret from the payment webhook above.
                webhookSecret: process.env.STRIPE_PAYOUT_WEBHOOK_SECRET,
                // What a connected account must satisfy before Mercur will mark it
                // ACTIVE and send it money. These are the defaults, written out rather
                // than inherited, because loosening them is a decision someone should
                // have to make deliberately: paying out to an account with outstanding
                // requirements is how funds end up stuck in limbo.
                accountValidation: {
                  detailsSubmitted: true,
                  chargesEnabled: true,
                  payoutsEnabled: true,
                  noOutstandingRequirements: true,
                  requiredCapabilities: [],
                },
              },
            },
          ],
        },
      },
    ]

const fileProviders =
  FILE_STORAGE === 's3'
    ? [
        {
          resolve: '@medusajs/medusa/file-s3',
          id: 's3',
          options: {
            file_url: process.env.S3_FILE_PUBLIC_URL,
            bucket: process.env.S3_FILE_BUCKET,
            prefix: process.env.S3_FILE_PREFIX || '',
            endpoint: process.env.S3_ENDPOINT,
            region: process.env.S3_REGION || 'us-east-1',
            access_key_id: process.env.S3_ACCESS_KEY_ID,
            secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
            // `false` makes the provider omit the ACL header entirely. That is the
            // right default off AWS: self-hosted S3 servers commonly reject or
            // ignore canned ACLs, and public reads come from a bucket policy
            // instead. Set S3_FILE_ACL=public-read on AWS if you rely on
            // per-object ACLs there.
            acl: process.env.S3_FILE_ACL || false,
            additional_client_config: {
              // RustFS and most self-hosted S3 servers address buckets by path
              // (endpoint/bucket), not as a subdomain the way AWS does.
              forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
            },
          },
        },
      ]
    : [
        {
          resolve: '@medusajs/medusa/file-local',
          id: 'local',
          options: {
            // The local provider bakes this into every uploaded file URL.
            // It must be the publicly reachable origin in production, or
            // images resolve to localhost and render broken.
            backend_url: process.env.FILE_BACKEND_URL || 'http://localhost:9000/static',
          },
        },
      ]

module.exports = withMercur({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    // OVERLAY 2/6 — Redis session store + worker mode.
    // "shared" runs HTTP and background jobs in one process. docker-compose.yml
    // splits them: MEDUSA_WORKER_MODE=server on `backend`, `worker` on `worker`.
    ...(REDIS_URL ? { redisUrl: REDIS_URL } : {}),
    ...(INSECURE_COOKIES
      ? { cookieOptions: { secure: false, sameSite: 'lax' as const } }
      : {}),
    workerMode: (process.env.MEDUSA_WORKER_MODE as 'shared' | 'server' | 'worker') || 'shared',
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      vendorCors: process.env.VENDOR_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    }
  },
  featureFlags: {
    seller_registration: true
  },
  modules: [
    {
      resolve: '@mercurjs/core/modules/admin-ui',
      options: {
        appDir: dashboardAppDir('admin'),
        path: '/dashboard',
      }
    },
    {
      resolve: '@mercurjs/core/modules/vendor-ui',
      options: {
        appDir: dashboardAppDir('vendor'),
        path: '/seller',
      }
    },
    // OVERLAY 1/6 (cont.) — spliced in ahead of the file module, same as the
    // Mercur development monorepo's own apps/api config does.
    ...redisModules,
    {
      resolve: '@medusajs/medusa/file',
      // OVERLAY 4/6 (cont.) — local volume, or S3 when S3_FILE_BUCKET is set.
      options: { providers: fileProviders },
    },
    // OVERLAY 5/6 (cont.) — empty unless EMAIL_PROVIDER selects one.
    ...notificationModules,
    // OVERLAY 6/6 (cont.) — empty unless PAYMENTS includes stripe, in which case this
    // is two modules: payments in, payouts out.
    ...paymentModules,
  ],
})
