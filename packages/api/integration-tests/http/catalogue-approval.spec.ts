import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { createSellerStockLocationsWorkflow } from "@mercurjs/core/workflows"
import { createShippingProfilesWorkflow } from "@medusajs/medusa/core-flows"

jest.setTimeout(5 * 60 * 1000)

const PASSWORD = "supersecret"

/**
 * A vendor's product does not go straight into the catalogue: it is created as `proposed`
 * and an operator has to confirm it before it is published. That review step is the whole
 * reason a marketplace can let strangers list things, so it is worth pinning down — a
 * change that published on creation would look normal in every panel and become obvious
 * only when something unreviewed turned up on the storefront.
 *
 * NOTE ON STRUCTURE — this is deliberately one long test rather than four readable ones.
 * `medusaIntegrationTestRunner` snapshots the database after `beforeAll` and restores it
 * before each `it`, so anything created *inside* a test is gone by the next one. Splitting
 * this up gives a first test that passes and a second that 404s on the row the first one
 * just created, which reads like a broken API rather than a rolled-back database.
 * Fixtures belong in `beforeAll`; a flow that builds on itself stays in one `it`.
 */
medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("catalogue approval", () => {
      let adminToken: string
      let sellerId: string
      let memberToken: string
      let shippingProfileId: string
      let stockLocationId: string

      const adminHeaders = () => ({ headers: { authorization: `Bearer ${adminToken}` } })
      const vendorHeaders = () => ({
        headers: { authorization: `Bearer ${memberToken}`, "x-seller-id": sellerId },
      })

      beforeAll(async () => {
        const container = getContainer()
        const auth = container.resolve(Modules.AUTH)
        const userService = container.resolve(Modules.USER)

        const adminEmail = "operator@catalogue.test"
        const reg = await auth.register("emailpass", {
          body: { email: adminEmail, password: PASSWORD },
        })
        const [user] = await userService.createUsers([{ email: adminEmail }])
        await auth.updateAuthIdentities([
          { id: reg.authIdentity!.id, app_metadata: { user_id: user.id } },
        ])
        adminToken = (
          await api.post("/auth/user/emailpass", { email: adminEmail, password: PASSWORD })
        ).data.token

        // A seller, self-registered then approved, exactly as one arrives in practice.
        const sellerEmail = "vendor@catalogue.test"
        const registerToken = (
          await api.post("/auth/member/emailpass/register", {
            email: sellerEmail,
            password: PASSWORD,
          })
        ).data.token

        sellerId = (
          await api.post(
            "/vendor/sellers",
            {
              name: "Catalogue Store",
              email: sellerEmail,
              currency_code: "eur",
              member_email: sellerEmail,
            },
            { headers: { authorization: `Bearer ${registerToken}` } }
          )
        ).data.seller.id

        await api.post(`/admin/sellers/${sellerId}/approve`, {}, adminHeaders())

        // Re-authenticate now the member exists, so the token carries an actor_id.
        memberToken = (
          await api.post("/auth/member/emailpass", { email: sellerEmail, password: PASSWORD })
        ).data.token

        // An offer needs somewhere to ship from and a profile to ship under. Built with
        // the same workflows the seed uses rather than by hand.
        const { result: profiles } = await createShippingProfilesWorkflow(container).run({
          input: { data: [{ name: "Catalogue Test Profile", type: "default" }] },
        })
        shippingProfileId = profiles[0].id

        const { result: locations } = await createSellerStockLocationsWorkflow(container).run({
          input: {
            seller_id: sellerId,
            locations: [
              {
                name: "Catalogue Warehouse",
                address: { city: "Berlin", country_code: "DE", address_1: "Test 1" },
              },
            ],
          },
        })
        stockLocationId = locations[0].id
      })

      it("holds a vendor product at proposed until an operator confirms it, then allows an offer", async () => {
        // Shaped like the seed: no product-level `options`, and a variant with no option
        // map. Supplying both produces "Product has 1 option values but there were 2
        // provided option values for the variant".
        const created = await api.post(
          "/vendor/products",
          {
            title: "Reviewed Widget",
            variants: [{ title: "One Size", sku: "REVIEWED-WIDGET-OS" }],
          },
          vendorHeaders()
        )

        expect(created.status).toEqual(201)
        expect(created.data.product.status).toEqual("proposed")
        expect(created.data.product.status).not.toEqual("published")

        const productId = created.data.product.id
        const variantId = created.data.product.variants[0].id

        const before = await api.get(`/admin/products/${productId}`, adminHeaders())
        expect(before.data.product.status).toEqual("proposed")

        await api.post(`/admin/products/${productId}/confirm`, {}, adminHeaders())

        const after = await api.get(`/admin/products/${productId}`, adminHeaders())
        expect(after.data.product.status).toEqual("published")

        // Offers are where price and stock actually live; the product is the shared
        // listing they hang off.
        const offer = await api.post(
          "/vendor/offers",
          {
            sku: "CATALOGUE-TEST-1",
            variant_id: variantId,
            shipping_profile_id: shippingProfileId,
            inventory_items: [
              {
                sku: "CATALOGUE-TEST-1",
                stock_levels: [{ location_id: stockLocationId, stocked_quantity: 5 }],
              },
            ],
            prices: [{ amount: 1000, currency_code: "eur" }],
          },
          vendorHeaders()
        )
        expect([200, 201]).toContain(offer.status)

        const listed = await api.get("/vendor/offers", vendorHeaders())
        expect(listed.data.offers.map((o) => o.sku)).toContain("CATALOGUE-TEST-1")
      })
    })
  },
})
