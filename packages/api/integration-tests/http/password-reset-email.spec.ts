import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"

jest.setTimeout(5 * 60 * 1000)

const PASSWORD = "supersecret"

/**
 * Requesting a password reset must actually send the token somewhere.
 *
 * Medusa mints the token and emits `auth.password_reset`; nothing listened for it, so the
 * route answered 201 and the mail went nowhere. The reset form appeared to work and no
 * email ever arrived — the same silent failure the seller invitation had.
 *
 * Uses the `user` actor type because an operator fixture is cheap; the per-actor URL
 * routing is covered by unit tests, which can vary the environment freely.
 *
 * One `it`: the runner restores the database between tests.
 */
medusaIntegrationTestRunner({
  inApp: true,
  env: { MERCUR_BACKEND_URL: "https://api.reset.test" },
  testSuite: ({ api, getContainer }) => {
    describe("password reset email", () => {
      const email = "operator@reset.test"

      beforeAll(async () => {
        const container = getContainer()
        const auth = container.resolve(Modules.AUTH)
        const userService = container.resolve(Modules.USER)

        const reg = await auth.register("emailpass", {
          body: { email, password: PASSWORD },
        })
        const [user] = await userService.createUsers([{ email }])
        await auth.updateAuthIdentities([
          { id: reg.authIdentity!.id, app_metadata: { user_id: user.id } },
        ])
      })

      it("emails a reset link to an operator who asks for one", async () => {
        const container = getContainer()

        const res = await api.post("/auth/user/emailpass/reset-password", {
          identifier: email,
        })
        expect(res.status).toEqual(201)

        const notificationService = container.resolve(Modules.NOTIFICATION)
        const sent = await waitFor(async () => {
          const rows = await notificationService.listNotifications({ to: email })
          return rows.length ? rows : null
        })

        expect(sent).not.toBeNull()
        expect(sent![0]).toMatchObject({
          to: email,
          channel: "email",
          template: "passwordReset",
        })

        // The row alone proves nothing: createNotifications persists before handing off to
        // a provider, so with none configured the row appears and nothing is delivered.
        // `status` is what separates "sent" from merely "recorded".
        expect(sent![0].status).toEqual("success")

        // The link has to point at the panel this actor actually logs into. A reset that
        // lands on the wrong front end is indistinguishable from a broken link.
        expect(sent![0].data).toMatchObject({ actor_type: "user" })
        expect((sent![0].data as { reset_url?: string }).reset_url).toContain(
          "https://api.reset.test/dashboard/reset-password?token="
        )
      })

      it("stays silent about an address that has no account", async () => {
        const container = getContainer()
        const unknown = "nobody@reset.test"

        // Medusa answers 201 either way so the endpoint cannot be used to enumerate
        // accounts. That property only holds if no email goes out for a miss.
        const res = await api.post("/auth/user/emailpass/reset-password", {
          identifier: unknown,
        })
        expect(res.status).toEqual(201)

        const notificationService = container.resolve(Modules.NOTIFICATION)
        await new Promise((r) => setTimeout(r, 1500))

        const rows = await notificationService.listNotifications({ to: unknown })
        expect(rows).toHaveLength(0)
      })

      const waitFor = async <T>(
        check: () => Promise<T | null>,
        attempts = 25
      ): Promise<T | null> => {
        for (let i = 0; i < attempts; i++) {
          const result = await check()
          if (result) {
            return result
          }
          await new Promise((r) => setTimeout(r, 200))
        }
        return null
      }
    })
  },
})
