import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import seedDemoData from "../../src/scripts/seed"

// Two full seeds against one database. The seed creates a dozen products and a
// couple of hundred offers, so give it room.
jest.setTimeout(10 * 60 * 1000)

/**
 * Guards the defect that took a deployment down: the seed was not idempotent, and
 * `RUN_SEED=true` is documented as safe to leave on. On any restart where the marker
 * was missing it re-ran against a populated database, failed on rows it had already
 * written, and exited the entrypoint — which Compose restarted, which failed again.
 * The site was unreachable, not merely missing its demo data.
 *
 * The second failure mode was quieter and arguably worse: the parts that did not
 * fail happily overwrote live configuration, resetting the store name and replacing
 * `supported_currencies` wholesale. An operator who had added a currency lost it on
 * a restart, with nothing in the logs saying so.
 *
 * So this asserts two different things: that a second seed does not throw, and that
 * it does not touch what an operator may have changed.
 */
medusaIntegrationTestRunner({
  inApp: true,
  env: {},
  testSuite: ({ getContainer }) => {
    describe("seed idempotency", () => {
      it("runs twice without failing, and leaves operator settings alone", async () => {
        const container = getContainer()
        const exec = { container, args: [] } as any

        await seedDemoData(exec)

        const storeService = container.resolve(Modules.STORE)
        const regionService = container.resolve(Modules.REGION)
        const taxService = container.resolve(Modules.TAX)
        const query = container.resolve(ContainerRegistrationKeys.QUERY)

        const countCategories = async () => {
          const { data } = await query.graph({
            entity: "product_category",
            fields: ["id"],
          })
          return data.length
        }
        const countSellers = async () => {
          const { data } = await query.graph({ entity: "seller", fields: ["id"] })
          return data.length
        }

        // Stand in for an operator who has configured the marketplace after seeding:
        // a third currency and a renamed store, neither of which the seed put there.
        // `supported_currencies` is a relation and is not returned unless asked for —
        // the same id-only-rows trap that caused the category bug in the seed itself.
        const listStore = async () =>
          (await storeService.listStores({}, { relations: ["supported_currencies"] }))[0]

        const seeded = await listStore()
        await storeService.updateStores(seeded.id, {
          name: "Operator Renamed This",
          supported_currencies: [
            { currency_code: "eur", is_default: true },
            { currency_code: "usd" },
            { currency_code: "thb" },
          ],
        })

        const before = {
          regions: (await regionService.listRegions()).length,
          taxRegions: (await taxService.listTaxRegions()).length,
          categories: await countCategories(),
          sellers: await countSellers(),
        }

        // The actual regression: this used to throw, and the container died with it.
        await expect(seedDemoData(exec)).resolves.not.toThrow()

        const after = await listStore()

        expect(after.name).toEqual("Operator Renamed This")
        expect(after.supported_currencies).toBeDefined()
        expect(
          after.supported_currencies!.map((c) => c.currency_code).sort()
        ).toEqual(["eur", "thb", "usd"])

        // Nothing duplicated. Each of these was created by the first seed and must be
        // recognised as already present by the second.
        expect(await regionService.listRegions()).toHaveLength(before.regions)
        expect(await taxService.listTaxRegions()).toHaveLength(before.taxRegions)
        expect(await countCategories()).toEqual(before.categories)
        expect(await countSellers()).toEqual(before.sellers)
      })
    })
  },
})
