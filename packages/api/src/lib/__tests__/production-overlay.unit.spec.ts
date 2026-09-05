import { applyProductionOverlay, type MedusaConfigInput } from "../production-overlay"

/**
 * These guards used to be reachable only from the container smoke suite, which builds an
 * image and runs on pull requests. Since the overlay became an ordinary module under
 * src/, they run here in milliseconds instead.
 *
 * The smoke suite still covers what this cannot: that the *compiled artifact* loads
 * inside a real container. This covers what it should not have to — the branching.
 */

const baseConfig = (): MedusaConfigInput => ({
  projectConfig: { databaseUrl: "postgres://x" },
  featureFlags: { seller_registration: true },
  modules: [
    { resolve: "@mercurjs/core/modules/admin-ui" },
    { resolve: "@mercurjs/core/modules/vendor-ui" },
    {
      resolve: "@medusajs/medusa/notification",
      options: { providers: [{ resolve: "@medusajs/medusa/notification-local", id: "local" }] },
    },
    { resolve: "@medusajs/medusa/file", options: { providers: [{ resolve: "@medusajs/medusa/file-local" }] } },
  ],
})

const resolves = (c: MedusaConfigInput) => c.modules.map((m) => m.resolve)

describe("production overlay", () => {
  const ENV = process.env

  beforeEach(() => {
    // A clean slate, so "unset" genuinely means unset rather than inherited.
    process.env = { ...ENV }
    for (const k of [
      "REDIS_URL", "MEDUSA_WORKER_MODE", "INSECURE_COOKIES", "FILE_STORAGE",
      "EMAIL_PROVIDER", "PAYMENTS", "STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PAYOUT_WEBHOOK_SECRET", "S3_FILE_BUCKET", "S3_FILE_PUBLIC_URL",
      "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "RESEND_API_KEY", "RESEND_FROM",
    ]) delete process.env[k]
  })

  afterAll(() => {
    process.env = ENV
  })

  it("is a no-op when nothing is configured", () => {
    // This is what makes one config file serve development and the container. If this
    // ever fails, `npm run dev` has silently changed behaviour.
    const base = baseConfig()
    expect(applyProductionOverlay(baseConfig())).toEqual(base)
  })

  describe("redis", () => {
    it("registers the redis modules ahead of the file module", () => {
      process.env.REDIS_URL = "redis://r:6379"
      const out = applyProductionOverlay(baseConfig())

      expect(out.projectConfig.redisUrl).toEqual("redis://r:6379")
      expect(resolves(out)).toContain("@medusajs/medusa/workflow-engine-redis")
      // Ordering matters: the Mercur monorepo's own config splices them here.
      expect(resolves(out).indexOf("@medusajs/medusa/cache-redis")).toBeLessThan(
        resolves(out).indexOf("@medusajs/medusa/file")
      )
    })

    it("adds nothing when REDIS_URL is unset", () => {
      expect(resolves(applyProductionOverlay(baseConfig()))).not.toContain(
        "@medusajs/medusa/cache-redis"
      )
    })
  })

  describe("worker mode and cookies", () => {
    it("sets workerMode only when asked", () => {
      expect(applyProductionOverlay(baseConfig()).projectConfig.workerMode).toBeUndefined()
      process.env.MEDUSA_WORKER_MODE = "worker"
      expect(applyProductionOverlay(baseConfig()).projectConfig.workerMode).toEqual("worker")
    })

    it("loosens the session cookie only on an explicit true", () => {
      // Medusa hardcodes secure:true in production, and express-session then declines to
      // send Set-Cookie over http — the panel bounces back to login with no error.
      process.env.INSECURE_COOKIES = "false"
      expect(applyProductionOverlay(baseConfig()).projectConfig.cookieOptions).toBeUndefined()
      process.env.INSECURE_COOKIES = "true"
      expect(applyProductionOverlay(baseConfig()).projectConfig.cookieOptions).toEqual({
        secure: false,
        sameSite: "lax",
      })
    })
  })

  describe("file storage", () => {
    const s3Env = () => {
      process.env.FILE_STORAGE = "s3"
      process.env.S3_FILE_BUCKET = "b"
      process.env.S3_FILE_PUBLIC_URL = "https://cdn.test"
      process.env.S3_ACCESS_KEY_ID = "k"
      process.env.S3_SECRET_ACCESS_KEY = "s"
    }

    it("swaps the provider for s3", () => {
      s3Env()
      const file = applyProductionOverlay(baseConfig()).modules.find(
        (m) => m.resolve === "@medusajs/medusa/file"
      )
      const providers = (file!.options as { providers: { resolve: string }[] }).providers
      expect(providers).toHaveLength(1)
      expect(providers[0].resolve).toEqual("@medusajs/medusa/file-s3")
    })

    it("leaves the base provider alone for local", () => {
      process.env.FILE_STORAGE = "local"
      expect(applyProductionOverlay(baseConfig())).toEqual(baseConfig())
    })

    it("refuses an unrecognised value rather than falling back", () => {
      process.env.FILE_STORAGE = "nonsense"
      expect(() => applyProductionOverlay(baseConfig())).toThrow(/must be "local" or "s3"/)
    })

    it("names every missing s3 variable at once", () => {
      // One deploy cycle to fix the config, not four.
      process.env.FILE_STORAGE = "s3"
      expect(() => applyProductionOverlay(baseConfig())).toThrow(
        /S3_FILE_BUCKET, S3_FILE_PUBLIC_URL, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/
      )
    })
  })

  describe("email", () => {
    it("removes the notification module for none", () => {
      process.env.EMAIL_PROVIDER = "none"
      expect(resolves(applyProductionOverlay(baseConfig()))).not.toContain(
        "@medusajs/medusa/notification"
      )
    })

    it("keeps exactly one provider per channel", () => {
      process.env.EMAIL_PROVIDER = "resend"
      process.env.RESEND_API_KEY = "re_x"
      process.env.RESEND_FROM = "a@b.com"
      const out = applyProductionOverlay(baseConfig())
      const notif = out.modules.filter((m) => m.resolve === "@medusajs/medusa/notification")

      expect(notif).toHaveLength(1)
      const providers = (notif[0].options as { providers: { id: string }[] }).providers
      expect(providers).toHaveLength(1)
      expect(providers[0].id).toEqual("resend")
    })

    it("refuses an unrecognised provider", () => {
      process.env.EMAIL_PROVIDER = "nonsense"
      expect(() => applyProductionOverlay(baseConfig())).toThrow(/must be "none", "local" or "resend"/)
    })

    it("names every missing resend variable at once", () => {
      process.env.EMAIL_PROVIDER = "resend"
      expect(() => applyProductionOverlay(baseConfig())).toThrow(/RESEND_API_KEY, RESEND_FROM/)
    })
  })

  describe("payments", () => {
    const stripeKeys = () => {
      process.env.STRIPE_API_KEY = "sk_x"
      process.env.STRIPE_WEBHOOK_SECRET = "w1"
      process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "w2"
    }

    it("adds no payment modules for the stub", () => {
      process.env.PAYMENTS = "stub"
      expect(resolves(applyProductionOverlay(baseConfig()))).not.toContain("@medusajs/medusa/payment")
    })

    it("registers both the payment and the payout integration", () => {
      // Two different Stripe integrations: one charges the customer, one pays sellers.
      process.env.PAYMENTS = "stripe"
      stripeKeys()
      const out = resolves(applyProductionOverlay(baseConfig()))
      expect(out).toContain("@medusajs/medusa/payment")
      expect(out).toContain("@mercurjs/core/modules/payout")
    })

    it("never captures at authorisation", () => {
      // Capturing before the split is known breaks the payout to sellers. This is the
      // single easiest thing here to get wrong.
      process.env.PAYMENTS = "stripe"
      stripeKeys()
      const payment = applyProductionOverlay(baseConfig()).modules.find(
        (m) => m.resolve === "@medusajs/medusa/payment"
      )
      const provider = (payment!.options as { providers: { options: Record<string, unknown> }[] })
        .providers[0]
      expect(provider.options.capture).toBe(false)
      // camelCase — the snake_case spelling in Mercur's guide is ignored silently.
      expect(provider.options.automaticPaymentMethods).toBe(true)
    })

    it("accepts a comma-separated list, with spaces", () => {
      process.env.PAYMENTS = " stub , stripe "
      stripeKeys()
      expect(resolves(applyProductionOverlay(baseConfig()))).toContain("@medusajs/medusa/payment")
    })

    it("refuses an unrecognised provider rather than taking no money quietly", () => {
      process.env.PAYMENTS = "nonsense"
      expect(() => applyProductionOverlay(baseConfig())).toThrow(/not recognised/)
    })

    it("names every missing stripe secret at once", () => {
      // The two webhook secrets are different; reusing one silently drops every event on
      // the other endpoint.
      process.env.PAYMENTS = "stripe"
      expect(() => applyProductionOverlay(baseConfig())).toThrow(
        /STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PAYOUT_WEBHOOK_SECRET/
      )
    })
  })
})
