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
 * All three actor types are exercised, because the routing between them is the part that
 * breaks in a way nobody notices: a seller sent to the admin panel gets a link that looks
 * fine and cannot work. The unit tests vary the environment freely; these prove the real
 * event carries the actor type through to the right front end.
 *
 * Each test stands alone — the runner restores the database between them, so every
 * identity is created in `beforeAll`.
 */
medusaIntegrationTestRunner({
  inApp: true,
  env: {
    MERCUR_BACKEND_URL: "https://api.reset.test",
    MERCUR_STOREFRONT_URL: "https://shop.reset.test",
  },
  testSuite: ({ api, getContainer }) => {
    describe("password reset email", () => {
      const email = "operator@reset.test"
      const memberEmail = "seller@reset.test"
      const customerEmail = "shopper@reset.test"

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

        // A seller, created the way one actually arrives, so the member identity exists.
        const registerToken = (
          await api.post("/auth/member/emailpass/register", {
            email: memberEmail,
            password: PASSWORD,
          })
        ).data.token
        await api.post(
          "/vendor/sellers",
          {
            name: "Reset Store",
            email: memberEmail,
            currency_code: "eur",
            member_email: memberEmail,
          },
          { headers: { authorization: `Bearer ${registerToken}` } }
        )

        await auth.register("emailpass", {
          body: { email: customerEmail, password: PASSWORD },
        })
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
          return settled(rows)
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

      it("sends a seller to the vendor panel, not the admin one", async () => {
        const container = getContainer()

        const res = await api.post("/auth/member/emailpass/reset-password", {
          identifier: memberEmail,
        })
        expect(res.status).toEqual(201)

        const notificationService = container.resolve(Modules.NOTIFICATION)
        const sent = await waitFor(async () => {
          const rows = await notificationService.listNotifications({ to: memberEmail })
          return settled(rows)
        })

        expect(sent).not.toBeNull()
        expect(sent![0].status).toEqual("success")
        expect(sent![0].data).toMatchObject({ actor_type: "member" })

        const url = (sent![0].data as { reset_url?: string }).reset_url
        expect(url).toContain("https://api.reset.test/seller/reset-password?token=")
        // The failure that matters: a seller handed the operator's panel.
        expect(url).not.toContain("/dashboard/")
      })

      it("sends a customer to the storefront", async () => {
        const container = getContainer()

        const res = await api.post("/auth/customer/emailpass/reset-password", {
          identifier: customerEmail,
        })
        expect(res.status).toEqual(201)

        const notificationService = container.resolve(Modules.NOTIFICATION)
        const sent = await waitFor(async () => {
          const rows = await notificationService.listNotifications({ to: customerEmail })
          return settled(rows)
        })

        expect(sent).not.toBeNull()
        expect(sent![0].status).toEqual("success")
        expect(sent![0].data).toMatchObject({ actor_type: "customer" })

        const url = (sent![0].data as { reset_url?: string }).reset_url
        expect(url).toContain("https://shop.reset.test/reset-password?token=")
        // A customer must never be sent into either operator-facing panel.
        expect(url).not.toContain("/dashboard/")
        expect(url).not.toContain("/seller/")
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

      // `createNotifications` writes the row and hands it to a provider afterwards, so a
      // row can exist while `status` is still "pending". Polling for existence alone
      // makes every status assertion a race that a slower runner loses.
      const settled = <T extends { status?: string }>(rows: T[]): T[] | null =>
        rows.length && rows.every((r) => r.status !== "pending") ? rows : null

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
