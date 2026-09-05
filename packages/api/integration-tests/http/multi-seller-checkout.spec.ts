import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createSellerShippingOptionsWorkflow,
  createSellerStockLocationsWorkflow,
} from "@mercurjs/core/workflows"
import {
  createLocationFulfillmentSetWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createServiceZonesWorkflow,
  createShippingProfilesWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows"

jest.setTimeout(5 * 60 * 1000)

const PASSWORD = "supersecret"

/**
 * The property that makes this a marketplace rather than a shop: one cart holding two
 * sellers' offers completes into ONE order group containing ONE order per seller.
 *
 * This is worth pinning down because the split is invisible from the storefront. A cart
 * that quietly produced a single combined order would look correct at checkout — the
 * shopper sees one confirmation either way — and would only surface later, as a seller
 * unable to fulfil items that are not theirs, or as a payout split that cannot be
 * computed. Items are grouped by `item.offer.seller_id`, so the offer, not the product,
 * is what ties a line to a seller; a regression in that link is what this catches.
 *
 * NOTE ON STRUCTURE — one long test, deliberately. `medusaIntegrationTestRunner`
 * snapshots the database after `beforeAll` and restores it before each `it`, so anything
 * created *inside* a test is gone by the next one. A checkout split across several `it`
 * blocks gives a first test that passes and a second that 404s on the cart the first one
 * just created, which reads like a broken API rather than a rolled-back database.
 */
medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ api, getContainer }) => {
    describe("multi-seller checkout", () => {
      let adminToken: string
      let regionId: string
      let salesChannelId: string
      let publishableKey: string
      let shippingProfileId: string
      let customerToken: string

      type Seller = {
        id: string
        name: string
        offerId: string
        shippingOptionId: string
        memberToken: string
      }
      const sellers: Record<"a" | "b", Seller> = {} as Record<"a" | "b", Seller>

      const adminHeaders = () => ({ headers: { authorization: `Bearer ${adminToken}` } })
      const storeHeaders = () => ({
        headers: {
          "x-publishable-api-key": publishableKey,
          authorization: `Bearer ${customerToken}`,
        },
      })

      beforeAll(async () => {
        const container = getContainer()
        const auth = container.resolve(Modules.AUTH)
        const userService = container.resolve(Modules.USER)
        const query = container.resolve(ContainerRegistrationKeys.QUERY)
        const link = container.resolve(ContainerRegistrationKeys.LINK)

        const adminEmail = "operator@checkout.test"
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

        // The storefront half of the fixture: a region to price in, a sales channel to
        // sell through, and a publishable key bound to it. The store API refuses without
        // the key and the runner seeds none.
        const { result: regions } = await createRegionsWorkflow(container).run({
          input: {
            regions: [
              {
                name: "Checkout Test Region",
                currency_code: "eur",
                countries: ["de"],
                payment_providers: ["pp_system_default"],
              },
            ],
          },
        })
        regionId = regions[0].id

        const { result: channels } = await createSalesChannelsWorkflow(container).run({
          input: { salesChannelsData: [{ name: "Checkout Test Channel" }] },
        })
        salesChannelId = channels[0].id

        const key = await api.post(
          "/admin/api-keys",
          { title: "checkout-test", type: "publishable" },
          adminHeaders()
        )
        publishableKey = key.data.api_key.token
        await api.post(
          `/admin/api-keys/${key.data.api_key.id}/sales-channels`,
          { add: [salesChannelId] },
          adminHeaders()
        )

        const { result: profiles } = await createShippingProfilesWorkflow(container).run({
          input: { data: [{ name: "Checkout Test Profile", type: "default" }] },
        })
        shippingProfileId = profiles[0].id

        // Two sellers, each independently sellable: approved, with stock in a location on
        // the sales channel, a shipping option of their own, and one published offer.
        const makeSeller = async (slug: string, name: string): Promise<Seller> => {
          const email = `${slug}@checkout.test`
          const registerToken = (
            await api.post("/auth/member/emailpass/register", { email, password: PASSWORD })
          ).data.token

          const sellerId = (
            await api.post(
              "/vendor/sellers",
              {
                name,
                email,
                currency_code: "eur",
                member_email: email,
              },
              { headers: { authorization: `Bearer ${registerToken}` } }
            )
          ).data.seller.id

          await api.post(`/admin/sellers/${sellerId}/approve`, {}, adminHeaders())

          // Re-authenticate now the member exists, so the token carries an actor_id.
          const memberToken = (
            await api.post("/auth/member/emailpass", { email, password: PASSWORD })
          ).data.token
          const vendorHeaders = {
            headers: { authorization: `Bearer ${memberToken}`, "x-seller-id": sellerId },
          }

          const { result: locations } = await createSellerStockLocationsWorkflow(container).run({
            input: {
              seller_id: sellerId,
              locations: [
                {
                  name: `${name} Warehouse`,
                  address: { city: "Berlin", country_code: "DE", address_1: "Test 1" },
                },
              ],
            },
          })
          const stockLocationId = locations[0].id

          // Without the fulfillment provider link the seller's shipping option is not
          // fulfillable; without the sales channel link its stock is invisible to the cart.
          await link.create({
            [Modules.STOCK_LOCATION]: { stock_location_id: stockLocationId },
            [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
          })
          await linkSalesChannelsToStockLocationWorkflow(container).run({
            input: { id: stockLocationId, add: [salesChannelId] },
          })

          await createLocationFulfillmentSetWorkflow(container).run({
            input: {
              location_id: stockLocationId,
              fulfillment_set_data: { name: `${name} delivery`, type: "shipping" },
            },
          })
          const {
            data: [locationWithSet],
          } = await query.graph({
            entity: "stock_location",
            fields: ["id", "fulfillment_sets.id"],
            filters: { id: stockLocationId },
          })
          const fulfillmentSetId = locationWithSet?.fulfillment_sets?.[0]?.id
          if (!fulfillmentSetId) {
            throw new Error(`Fulfillment set was not created for "${name}"`)
          }

          const { result: serviceZones } = await createServiceZonesWorkflow(container).run({
            input: {
              data: [
                {
                  fulfillment_set_id: fulfillmentSetId,
                  name: `${name} Europe`,
                  geo_zones: [{ country_code: "de", type: "country" as const }],
                },
              ],
            },
          })

          const { result: shippingOptions } = await createSellerShippingOptionsWorkflow(
            container
          ).run({
            input: {
              seller_id: sellerId,
              shipping_options: [
                {
                  name: `${name} Standard`,
                  price_type: "flat",
                  provider_id: "manual_manual",
                  service_zone_id: serviceZones[0].id,
                  shipping_profile_id: shippingProfileId,
                  type: { label: "Standard", description: "Ship in 2-3 days.", code: "standard" },
                  prices: [
                    { currency_code: "eur", amount: 10 },
                    { region_id: regionId, amount: 10 },
                  ],
                  rules: [
                    { attribute: "enabled_in_store", value: "true", operator: "eq" },
                    { attribute: "is_return", value: "false", operator: "eq" },
                  ],
                },
              ],
            },
          })

          // Shaped like the seed: no product-level `options`, and a variant with no option
          // map. Supplying both trips "Product has 1 option values but there were 2
          // provided option values for the variant".
          const product = await api.post(
            "/vendor/products",
            {
              title: `${name} Widget`,
              variants: [{ title: "One Size", sku: `${slug.toUpperCase()}-WIDGET-OS` }],
            },
            vendorHeaders
          )
          const productId = product.data.product.id
          const variantId = product.data.product.variants[0].id

          // A proposed product is not purchasable; the offer needs a published one.
          await api.post(`/admin/products/${productId}/confirm`, {}, adminHeaders())

          const offer = await api.post(
            "/vendor/offers",
            {
              sku: `${slug.toUpperCase()}-OFFER-1`,
              variant_id: variantId,
              shipping_profile_id: shippingProfileId,
              inventory_items: [
                {
                  sku: `${slug.toUpperCase()}-OFFER-1`,
                  stock_levels: [{ location_id: stockLocationId, stocked_quantity: 5 }],
                },
              ],
              prices: [{ amount: 1000, currency_code: "eur" }],
            },
            vendorHeaders
          )

          return {
            id: sellerId,
            name,
            offerId: offer.data.offer.id,
            shippingOptionId: shippingOptions[0].id,
            memberToken,
          }
        }

        sellers.a = await makeSeller("alpha", "Alpha Store")
        sellers.b = await makeSeller("beta", "Beta Store")

        // A real shopper, not a guest: `/store/order-groups` is scoped to the
        // authenticated customer, so a guest cart's group belongs to nobody and the
        // route answers 401.
        const shopperEmail = "shopper@checkout.test"
        const registrationToken = (
          await api.post("/auth/customer/emailpass/register", {
            email: shopperEmail,
            password: PASSWORD,
          })
        ).data.token
        await api.post(
          "/store/customers",
          { email: shopperEmail, first_name: "Test", last_name: "Shopper" },
          {
            headers: {
              authorization: `Bearer ${registrationToken}`,
              "x-publishable-api-key": publishableKey,
            },
          }
        )
        customerToken = (
          await api.post("/auth/customer/emailpass", {
            email: shopperEmail,
            password: PASSWORD,
          })
        ).data.token
      })

      it("splits a cart holding two sellers' offers into one order group with one order each", async () => {
        const cart = await api.post(
          "/store/carts",
          {
            region_id: regionId,
            sales_channel_id: salesChannelId,
            email: "shopper@checkout.test",
            currency_code: "eur",
            shipping_address: {
              first_name: "Test",
              last_name: "Shopper",
              address_1: "Test 1",
              city: "Berlin",
              country_code: "de",
              postal_code: "10115",
            },
          },
          storeHeaders()
        )
        const cartId = cart.data.cart.id

        for (const seller of [sellers.a, sellers.b]) {
          await api.post(
            `/store/carts/${cartId}/line-items`,
            { offer_id: seller.offerId, quantity: 1 },
            storeHeaders()
          )
        }

        // Each seller ships its own items, so each contributes its own shipping method.
        for (const seller of [sellers.a, sellers.b]) {
          await api.post(
            `/store/carts/${cartId}/shipping-methods`,
            { option_id: seller.shippingOptionId },
            storeHeaders()
          )
        }

        const withItems = await api.get(`/store/carts/${cartId}`, storeHeaders())
        expect(withItems.data.cart.items).toHaveLength(2)

        const collection = await api.post(
          "/store/payment-collections",
          { cart_id: cartId },
          storeHeaders()
        )
        await api.post(
          `/store/payment-collections/${collection.data.payment_collection.id}/payment-sessions`,
          { provider_id: "pp_system_default" },
          storeHeaders()
        )

        const completed = await api.post(`/store/carts/${cartId}/complete`, {}, storeHeaders())

        // `type: "cart"` means payment needed further action and nothing was split —
        // assert on it directly so a payment failure does not present as a missing group.
        expect(completed.data.type).toEqual("order_group")
        const group = completed.data.order_group
        expect(group.seller_count).toEqual(2)
        expect(group.cart_id).toEqual(cartId)

        // `items.*` is needed for the line-item metadata that carries `offer_id`; the
        // default field set omits it.
        const groups = await api.get(
          `/store/order-groups?id=${group.id}&fields=+orders.items.*`,
          storeHeaders()
        )
        const orders: {
          id: string
          items: { metadata?: { offer_id?: string } }[]
        }[] = groups.data.order_groups[0].orders
        expect(orders).toHaveLength(2)

        // The split groups items by the offer behind them, so the offer id is what ties
        // an order back to a seller. Each order must hold exactly one item, and the two
        // orders together must cover both sellers' offers — one each, not both in one.
        for (const order of orders) {
          expect(order.items).toHaveLength(1)
        }
        const offerIds = orders.map((o) => o.items[0].metadata?.offer_id).sort()
        expect(offerIds).toEqual([sellers.a.offerId, sellers.b.offerId].sort())

        // And the same split seen from the sellers' side: each vendor sees its own single
        // order and nothing of the other's. This is the property that makes the group
        // operable — one seller fulfilling must not see, or be blocked by, the other.
        const seenBySeller = new Map<string, string[]>()
        for (const seller of [sellers.a, sellers.b]) {
          const res = await api.get("/vendor/orders", {
            headers: {
              authorization: `Bearer ${seller.memberToken}`,
              "x-seller-id": seller.id,
            },
          })
          seenBySeller.set(
            seller.id,
            res.data.orders.map((o: { id: string }) => o.id)
          )
        }
        // The shopper gets exactly one confirmation for the whole purchase, not one per
        // seller. Subscribing to `order.placed` instead of `order_group.created` would
        // send two here, and neither would show the whole basket.
        const notificationService = getContainer().resolve(Modules.NOTIFICATION)
        const confirmations = await waitFor(async () => {
          const rows = await notificationService.listNotifications({
            to: "shopper@checkout.test",
            template: "orderConfirmation",
          })
          return rows.length ? rows : null
        })
        expect(confirmations).not.toBeNull()
        expect(confirmations!).toHaveLength(1)
        // `status` separates delivered from merely recorded: the row is written before a
        // provider ever sees it.
        expect(confirmations![0].status).toEqual("success")
        expect(confirmations![0].data).toMatchObject({ seller_count: 2 })

        expect(seenBySeller.get(sellers.a.id)).toHaveLength(1)
        expect(seenBySeller.get(sellers.b.id)).toHaveLength(1)
        expect(seenBySeller.get(sellers.a.id)).not.toEqual(seenBySeller.get(sellers.b.id))
        expect([...seenBySeller.get(sellers.a.id)!, ...seenBySeller.get(sellers.b.id)!].sort()).toEqual(
          orders.map((o) => o.id).sort()
        )
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
