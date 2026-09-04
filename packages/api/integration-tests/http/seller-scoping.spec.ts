import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import {
  approveSellerWorkflow,
  createSellerAccountWorkflow,
} from "@mercurjs/core/workflows"

jest.setTimeout(5 * 60 * 1000)

const PASSWORD = "supersecret"

/**
 * Two things, one of which is a security property.
 *
 * The reported "bug" was that the admin dashboard and the Vendor Hub disagree about how
 * many stores exist. They are supposed to: `/admin/sellers` lists the marketplace,
 * `/vendor/sellers` lists only the seller accounts the signed-in member belongs to. It
 * looks like a defect often enough that someone will eventually "fix" it, so it is
 * written down as intended behaviour here.
 *
 * The second assertion is the one that matters. The same mechanism that makes the counts
 * differ is what stops one seller reading another's data, so a change that "fixed" the
 * count discrepancy would quietly turn a marketplace into one where every vendor can see
 * every other vendor's orders.
 */
medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("seller scoping", () => {
      let sellerA: { id: string; name: string }
      let sellerB: { id: string; name: string }
      let adminToken: string

      beforeAll(async () => {
        const container = getContainer()
        const auth = container.resolve(Modules.AUTH)

        const makeSeller = async (name: string, email: string) => {
          const registration = await auth.register("emailpass", {
            body: { email, password: PASSWORD },
          })

          let authIdentityId = registration.authIdentity?.id
          if (!authIdentityId) {
            const [identity] = await auth.listProviderIdentities({
              entity_id: email,
              provider: "emailpass",
            })
            authIdentityId = identity.auth_identity_id!
          }

          const { result: seller } = await createSellerAccountWorkflow(container).run({
            input: {
              auth_identity_id: authIdentityId,
              member_email: email,
              first_name: "Test",
              last_name: "Member",
              seller: { name, email, currency_code: "eur" },
            },
          })

          await approveSellerWorkflow(container).run({
            input: { seller_id: seller.id },
          })

          return { id: seller.id, name }
        }

        sellerA = await makeSeller("Scoping Store A", "a@scoping.test")
        sellerB = await makeSeller("Scoping Store B", "b@scoping.test")

        // An operator account. The runner seeds none, and `medusa user` is a CLI, so
        // build it the way that command does: an auth identity, a user row, and the
        // app_metadata link between them. A user without that link authenticates and
        // then fails every admin route.
        const userService = container.resolve(Modules.USER)
        const adminEmail = "operator@scoping.test"

        const adminRegistration = await auth.register("emailpass", {
          body: { email: adminEmail, password: PASSWORD },
        })
        const [adminUser] = await userService.createUsers([{ email: adminEmail }])
        await auth.updateAuthIdentities([
          {
            id: adminRegistration.authIdentity!.id,
            app_metadata: { user_id: adminUser.id },
          },
        ])

        const tokenRes = await api.post("/auth/user/emailpass", {
          email: adminEmail,
          password: PASSWORD,
        })
        adminToken = tokenRes.data.token
      })

      const memberToken = async (email: string) => {
        // Vendor routes authenticate the *member* actor. /auth/seller/emailpass also
        // returns a token, but with an empty actor_id, and every vendor route then 401s.
        const res = await api.post("/auth/member/emailpass", {
          email,
          password: PASSWORD,
        })
        return res.data.token
      }

      it("shows a member only the stores they belong to", async () => {
        const token = await memberToken("a@scoping.test")

        const res = await api.get("/vendor/sellers", {
          headers: { authorization: `Bearer ${token}` },
        })

        expect(res.status).toEqual(200)
        expect(res.data.count).toEqual(1)
        expect(res.data.seller_members.map((m) => m.seller.name)).toEqual([
          "Scoping Store A",
        ])
      })

      it("shows an operator every store on the marketplace", async () => {
        const res = await api.get("/admin/sellers?limit=100", {
          headers: { authorization: `Bearer ${adminToken}` },
        })

        expect(res.status).toEqual(200)
        const names = res.data.sellers.map((s) => s.name)
        expect(names).toEqual(expect.arrayContaining(["Scoping Store A", "Scoping Store B"]))
        expect(res.data.count).toBeGreaterThanOrEqual(2)
      })

      it("refuses to scope a member to a seller they do not belong to", async () => {
        const token = await memberToken("a@scoping.test")

        // Seller A's member, asking for seller B's data. Must not be answered.
        const res = await api
          .get("/vendor/orders", {
            headers: {
              authorization: `Bearer ${token}`,
              "x-seller-id": sellerB.id,
            },
          })
          .catch((e) => e.response)

        // Asserting the property, not the status code. Mercur answers this particular
        // refusal with 400 + type "not_allowed" (its own docs say 403 for that type, so
        // the number may well be corrected upstream); what must never change is that the
        // request is refused and no order data comes back.
        expect(res.status).toBeGreaterThanOrEqual(400)
        expect(res.data.type).toEqual("not_allowed")
        expect(res.data.orders).toBeUndefined()
      })
    })
  },
})
