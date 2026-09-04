import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"

jest.setTimeout(5 * 60 * 1000)

const PASSWORD = "supersecret"

/**
 * The seller lifecycle is the marketplace's front door and its main control surface:
 * self-registration must land in `pending_approval` rather than `open`, and only an
 * operator may move it on from there.
 *
 * Worth stating why this is worth a test even though nobody has broken it yet. The
 * statuses are what the storefront filters on — `/store/sellers` returns only `open`
 * sellers — so a registration that arrived already `open` would put an unreviewed seller
 * in front of customers, and a suspension that did not take would leave one there. That
 * is a governance failure rather than a crash, so nothing would alert on it.
 */
medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("seller lifecycle", () => {
      let adminToken: string

      const adminHeaders = () => ({ headers: { authorization: `Bearer ${adminToken}` } })

      beforeAll(async () => {
        const container = getContainer()
        const auth = container.resolve(Modules.AUTH)
        const userService = container.resolve(Modules.USER)
        const email = "operator@lifecycle.test"

        const registration = await auth.register("emailpass", {
          body: { email, password: PASSWORD },
        })
        const [user] = await userService.createUsers([{ email }])
        await auth.updateAuthIdentities([
          { id: registration.authIdentity!.id, app_metadata: { user_id: user.id } },
        ])

        const res = await api.post("/auth/user/emailpass", { email, password: PASSWORD })
        adminToken = res.data.token
      })

      // A seller registering themselves. The token has to come from the *register*
      // endpoint, not the login one: at this point no member exists yet, so
      // /auth/member/emailpass has nothing to authenticate and answers 401. Register
      // mints an auth identity with no actor attached, and POST /vendor/sellers is what
      // then creates the member and the seller against it.
      const registerSeller = async (name: string, email: string) => {
        const auth = await api.post("/auth/member/emailpass/register", {
          email,
          password: PASSWORD,
        })
        const token = auth.data.token

        const res = await api.post(
          "/vendor/sellers",
          { name, email, currency_code: "eur", member_email: email },
          { headers: { authorization: `Bearer ${token}` } }
        )
        return res.data.seller
      }

      const statusOf = async (id: string) => {
        const res = await api.get(`/admin/sellers?limit=100`, adminHeaders())
        return res.data.sellers.find((s) => s.id === id)?.status
      }

      it("puts a self-registered seller in pending_approval, not open", async () => {
        const seller = await registerSeller("Lifecycle Store", "lifecycle@seller.test")

        // The important half of this assertion is the second one. An operator who has not
        // reviewed anything must not already be selling.
        expect(seller.status).toEqual("pending_approval")
        expect(seller.status).not.toEqual("open")
      })

      it("moves through approve, suspend and reinstate under operator control", async () => {
        const seller = await registerSeller("Lifecycle Two", "lifecycle2@seller.test")
        expect(await statusOf(seller.id)).toEqual("pending_approval")

        await api.post(`/admin/sellers/${seller.id}/approve`, {}, adminHeaders())
        expect(await statusOf(seller.id)).toEqual("open")

        await api.post(`/admin/sellers/${seller.id}/suspend`, {}, adminHeaders())
        expect(await statusOf(seller.id)).toEqual("suspended")

        await api.post(`/admin/sellers/${seller.id}/unsuspend`, {}, adminHeaders())
        expect(await statusOf(seller.id)).toEqual("open")
      })

      it("hides sellers who are not open from the storefront", async () => {
        const open = await registerSeller("Storefront Visible", "visible@seller.test")
        const pending = await registerSeller("Storefront Hidden", "hidden@seller.test")
        await api.post(`/admin/sellers/${open.id}/approve`, {}, adminHeaders())

        const res = await api.get("/store/sellers", {
          headers: { "x-publishable-api-key": await publishableKey() },
        })

        const names = res.data.sellers.map((s) => s.name)
        expect(names).toContain("Storefront Visible")
        expect(names).not.toContain("Storefront Hidden")
        expect(pending.status).toEqual("pending_approval")
      })

      // The store API refuses without one, and the runner seeds none.
      const publishableKey = async () => {
        const res = await api.post(
          "/admin/api-keys",
          { title: "lifecycle-test", type: "publishable" },
          adminHeaders()
        )
        return res.data.api_key.token
      }
    })
  },
})
