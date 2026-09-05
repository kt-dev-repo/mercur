/**
 * Deployment overlay for `medusa-config.ts`.
 *
 * WHY THIS FILE EXISTS
 *
 * The deployment needs settings the upstream config has no notion of: Redis, worker
 * mode, cookie security, object storage, an email provider, payments. Those used to live
 * in `deploy/medusa-config.production.ts`, a 419-line file that was a *copy* of the
 * 83-line upstream config plus the additions, swapped in by the Dockerfile.
 *
 * The copy was the problem. When upstream changed `medusa-config.ts`, the production copy
 * silently kept the old version — a green build running configuration nobody wrote. So
 * the relationship is inverted: upstream's file stays upstream's, gains two lines, and
 * delegates here. This file is additive, so an upstream change can never conflict with it.
 *
 * HOW IT STAYS A NO-OP IN DEVELOPMENT
 *
 * Every block below acts **only when its variable is explicitly set**. Unset means "leave
 * the base config alone", not "apply a production default". That is what lets one config
 * file serve both: `npm run dev` sees exactly the upstream config, and
 * `deploy/docker-compose.yml` always passes these variables explicitly (with defaults of
 * its own), so the deployment gets the full overlay.
 *
 * The one consequence worth knowing: running the image WITHOUT compose and without
 * setting `EMAIL_PROVIDER` leaves the development notification provider in place, which
 * logs mail instead of dropping it. Safer than the alternative, but not the same as
 * `EMAIL_PROVIDER=none`.
 */

type ModuleEntry = {
  resolve: string
  id?: string
  options?: Record<string, unknown>
}

export type MedusaConfigInput = {
  projectConfig: Record<string, unknown>
  featureFlags?: Record<string, unknown>
  modules: ModuleEntry[]
  [key: string]: unknown
}

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value !== ''

/**
 * Redis. Required in production: the in-memory workflow engine loses in-flight workflow
 * state on every restart and cannot be shared between the server and worker containers.
 */
function redisModules(redisUrl: string): ModuleEntry[] {
  return [
    { resolve: '@medusajs/medusa/cache-redis', options: { redisUrl } },
    { resolve: '@medusajs/medusa/event-bus-redis', options: { redisUrl } },
    {
      resolve: '@medusajs/medusa/workflow-engine-redis',
      // This module logs "The `url` option is deprecated. Please use `redisUrl` instead"
      // on every boot. Do not act on it: at @medusajs/medusa 2.18.0 the loader still
      // destructures `options.redis.url`, so moving to `redisUrl` crashes the server with
      // "Cannot destructure property 'url' of '(intermediate value)' as it is undefined".
      // The warning is cosmetic; revisit only after a Medusa upgrade.
      options: { redis: { url: redisUrl } },
    },
    {
      resolve: '@medusajs/medusa/locking',
      options: {
        providers: [
          {
            resolve: '@medusajs/medusa/locking-redis',
            id: 'locking-redis',
            is_default: true,
            options: { redisUrl },
          },
        ],
      },
    },
  ]
}

/**
 * Uploads. One provider for the whole deployment, not a per-upload choice: @medusajs/file
 * refuses to boot with more than one registered.
 *
 * Switching only changes where NEW uploads go. Stored URLs are absolute, so existing files
 * keep resolving from wherever they were written — which is why the uploads volume stays
 * mounted after moving to s3. `backup.sh migrate-uploads` moves the old ones.
 */
function s3FileProvider(): ModuleEntry {
  return {
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
      // `false` makes the provider omit the ACL header entirely. That is the right
      // default off AWS: self-hosted S3 servers commonly reject or ignore canned ACLs,
      // and public reads come from a bucket policy instead. Set S3_FILE_ACL=public-read
      // on AWS if you rely on per-object ACLs there.
      acl: process.env.S3_FILE_ACL || false,
      additional_client_config: {
        // RustFS and most self-hosted S3 servers address buckets by path
        // (endpoint/bucket), not as a subdomain the way AWS does.
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      },
    },
  }
}

function notificationModule(provider: string): ModuleEntry {
  return {
    resolve: '@medusajs/medusa/notification',
    options: {
      providers: [
        provider === 'resend'
          ? {
              // Resolved from the build artifact, where `medusa build` compiles src/ to
              // the same relative path.
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
  }
}

/**
 * Payments and payouts are two different Stripe integrations. The payment provider
 * charges the customer; the payout provider transfers each seller their share afterwards.
 * Mercur uses Stripe's separate charges and transfers model, which makes the platform the
 * merchant of record.
 */
function stripeModules(): ModuleEntry[] {
  return [
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
              // NOT optional for a marketplace, and the easiest thing here to get wrong.
              // Capturing at authorisation takes the whole amount immediately, before the
              // split is known, which breaks the payout to sellers. The payout module
              // captures later, once fulfilment allows it.
              capture: false,
              // `automaticPaymentMethods`, camelCase — NOT the `automatic_payment_methods`
              // Mercur's Stripe Connect guide shows. The installed provider reads the
              // camelCase key (payment-stripe/dist/core/stripe-base.js) and ignores the
              // snake_case one silently, so the documented spelling leaves the intent
              // without automatic payment methods while looking configured. Verified
              // against 2.18.0; check again on upgrade.
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
              // What a connected account must satisfy before Mercur will mark it ACTIVE
              // and send it money. These are the defaults, written out rather than
              // inherited, because loosening them is a decision someone should have to
              // make deliberately: paying out to an account with outstanding requirements
              // is how funds end up stuck.
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
}

/**
 * Generic in the caller's config type so the return value is still exactly what
 * `withMercur` expects — the overlay adds modules and project settings, it does not
 * change the shape.
 */
export function applyProductionOverlay<T extends MedusaConfigInput>(config: T): T {
  const projectConfig = { ...config.projectConfig }
  let modules = [...config.modules]

  // --- Redis, and the worker split -----------------------------------------
  const REDIS_URL = process.env.REDIS_URL
  if (isSet(REDIS_URL)) {
    projectConfig.redisUrl = REDIS_URL
    // Spliced ahead of the file module, the same as the Mercur development monorepo's
    // own apps/api config does.
    const fileIndex = modules.findIndex((m) => m.resolve === '@medusajs/medusa/file')
    const at = fileIndex === -1 ? modules.length : fileIndex
    modules = [...modules.slice(0, at), ...redisModules(REDIS_URL), ...modules.slice(at)]
  }

  // "shared" runs HTTP and background jobs in one process; docker-compose.yml splits them
  // with `server` on the backend and `worker` on the worker.
  if (isSet(process.env.MEDUSA_WORKER_MODE)) {
    projectConfig.workerMode = process.env.MEDUSA_WORKER_MODE as 'shared' | 'server' | 'worker'
  }

  // --- Session cookie security ---------------------------------------------
  // Medusa's express-loader hardcodes `secure: true` whenever NODE_ENV is production or
  // staging, and express-session then silently declines to send Set-Cookie on a request
  // it does not consider secure. The symptom is precise and baffling: POST /auth/session
  // answers 200 with the user payload, no cookie is stored, and the panel bounces back to
  // its login screen with no error anywhere.
  //
  // Behind Traefik with a certificate this is correct and needs nothing. Set
  // INSECURE_COOKIES=true ONLY while serving over plain http — session cookies then
  // travel unencrypted and can be read off the network.
  if (process.env.INSECURE_COOKIES === 'true') {
    projectConfig.cookieOptions = { secure: false, sameSite: 'lax' as const }
  }

  // --- Uploads --------------------------------------------------------------
  const FILE_STORAGE = process.env.FILE_STORAGE
  if (isSet(FILE_STORAGE)) {
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

      modules = modules.map((m) =>
        m.resolve === '@medusajs/medusa/file'
          ? { ...m, options: { providers: [s3FileProvider()] } }
          : m
      )
    }
    // FILE_STORAGE=local is what the base config already declares, so it is left alone.
  }

  // --- Email ----------------------------------------------------------------
  const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER
  if (isSet(EMAIL_PROVIDER)) {
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

    // One provider per channel is a Medusa constraint, so this replaces the base module
    // rather than adding to it.
    modules = modules.filter((m) => m.resolve !== '@medusajs/medusa/notification')
    if (EMAIL_PROVIDER !== 'none') {
      modules.push(notificationModule(EMAIL_PROVIDER))
    }
  }

  // --- Payments -------------------------------------------------------------
  const PAYMENTS = (process.env.PAYMENTS || 'stub')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

  const KNOWN_PAYMENTS = ['stub', 'stripe']
  const unknown = PAYMENTS.filter((p) => !KNOWN_PAYMENTS.includes(p))
  if (unknown.length) {
    throw new Error(
      `PAYMENTS contains ${unknown.map((p) => `"${p}"`).join(', ')}, which ` +
        `${unknown.length > 1 ? 'are' : 'is'} not recognised. ` +
        `Valid values are ${KNOWN_PAYMENTS.join(', ')}, comma-separated. ` +
        'Refusing to guess: silently ignoring an unknown provider would leave the ' +
        'marketplace taking no money while appearing to be configured for it.'
    )
  }

  if (PAYMENTS.includes('stripe')) {
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

    modules.push(...stripeModules())
  }

  return { ...config, projectConfig, modules } as T
}
