// ---------------------------------------------------------------------------
// PRODUCTION OVERLAY — not upstream code, and not used in development.
//
// deploy/Dockerfile swaps this in for packages/api/medusa-config.ts *inside the
// image only*. The upstream file stays untouched in Git so `git pull` / template
// upgrades never conflict.
//
// It is a copy of the upstream config plus exactly three additions, each marked
// with "OVERLAY:" below:
//   1. the Redis-backed cache / event bus / workflow engine / locking modules
//   2. `workerMode`, so the server and worker containers can be split
//   3. an opt-out from Secure session cookies, for http-only deployments
//
// >>> WHEN YOU UPGRADE MERCUR, RE-SYNC THIS FILE. <<<
//   diff -u packages/api/medusa-config.ts deploy/medusa-config.production.ts
// Everything except the two OVERLAY blocks should be identical.
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

// OVERLAY 1/2 — Redis.
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

// OVERLAY 3/3 — session cookie security.
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

module.exports = withMercur({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    // OVERLAY 2/2 — Redis session store + worker mode.
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
    // OVERLAY 1/2 (cont.) — spliced in ahead of the file module, same as the
    // Mercur development monorepo's own apps/api config does.
    ...redisModules,
    {
      resolve: '@medusajs/medusa/file',
      options: {
        providers: [
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
        ],
      },
    },
  ],
})
