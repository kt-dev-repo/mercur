import handler, { config } from "../storefront-cache-revalidate"

/**
 * The tag names here are a CONTRACT with the storefront, which declares the identical set
 * in `src/lib/data/cache-tags.ts` and caches that data with `revalidate: false`. A
 * `revalidateTag` is therefore the only thing that will ever drop it:
 *
 *   - a tag the storefront does not cache under is a silent no-op
 *   - a tag it caches under that nothing here sends means the data is cached PERMANENTLY
 *
 * The second is what happened to categories and collections. These tests pin the names so
 * a rename on either side fails here rather than in a shopper's stale page.
 */

const CACHE_TAGS_DECLARED_BY_THE_STOREFRONT = [
  "products",
  "product-<handle>",
  "offers",
  "offer-<id>",
  "product-offers-<productId>",
  "categories",
  "category-<handle>",
  "collections",
  "collection-<handle>",
]

// `null` means "the lookup came back empty" — distinct from omitting the argument, which
// takes the default. An explicit `undefined` would silently take the default too.
const makeContainer = (handle: string | null = "the-handle") => ({
  resolve: () => ({
    graph: jest.fn().mockResolvedValue({ data: handle ? [{ handle }] : [] }),
  }),
})

const run = async (name: string, data: unknown, handle: string | null = "the-handle") => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" })
  ;(global as unknown as { fetch: unknown }).fetch = fetchMock

  await handler({
    event: { name, data } as never,
    container: makeContainer(handle) as never,
  } as never)

  if (!fetchMock.mock.calls.length) {
    return null
  }
  return JSON.parse(fetchMock.mock.calls[0][1].body).tags as string[]
}

describe("storefront cache revalidation", () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      STOREFRONT_REVALIDATE_URL: "http://storefront.test/api/revalidate",
      STOREFRONT_REVALIDATE_SECRET: "shh",
    }
  })

  afterAll(() => {
    process.env = OLD_ENV
  })

  it("sends the product tags for a product event", async () => {
    const tags = await run("product.updated", { id: "prod_1" }, "cool-shoe")
    expect(tags).toEqual(expect.arrayContaining(["products", "product-cool-shoe"]))
  })

  it("sends the offer tags, and the product's own, for an offer event", async () => {
    const tags = await run("offer.created", { id: "off_1", product_id: "prod_1" }, "cool-shoe")
    expect(tags).toEqual(
      expect.arrayContaining([
        "products",
        "product-cool-shoe",
        "offers",
        "offer-off_1",
        "product-offers-prod_1",
      ])
    )
  })

  it("sends the category tags for a category event", async () => {
    // Regression: categories are cached with `revalidate: false` and nothing sent these,
    // so a new or renamed category never reached a shopper.
    const tags = await run("product.product-category.updated", { id: "pcat_1" }, "sneakers")
    expect(tags).toEqual(expect.arrayContaining(["categories", "category-sneakers"]))
    // Not a product change — do not drop the whole catalogue for a rename.
    expect(tags).not.toContain("products")
  })

  it("sends the collection tags for a collection event", async () => {
    const tags = await run("product.product-collection.created", { id: "pcol_1" }, "summer")
    expect(tags).toEqual(expect.arrayContaining(["collections", "collection-summer"]))
    expect(tags).not.toContain("products")
  })

  it("still sends the base tag when the handle cannot be read back", async () => {
    // A deletion cannot be looked up, and dropping the listing is the part that matters.
    const tags = await run("product.product-category.deleted", { id: "pcat_1" }, null)
    expect(tags).toEqual(["categories"])
  })

  it("subscribes to every event whose tags it knows how to build", async () => {
    const events = config.event as string[]
    for (const name of [
      "product.product-category.created",
      "product.product-category.updated",
      "product.product-category.deleted",
      "product.product-collection.created",
      "product.product-collection.updated",
      "product.product-collection.deleted",
    ]) {
      expect([name, events.includes(name)]).toEqual([name, true])
    }
  })

  it("sends nothing when the storefront is not configured", async () => {
    process.env.STOREFRONT_REVALIDATE_URL = ""
    expect(await run("product.updated", { id: "prod_1" })).toBeNull()
  })

  it("emits only tags the storefront actually caches under", async () => {
    // Every tag this subscriber can produce must match a shape in the storefront's
    // CACHE_TAGS. A tag with no counterpart there is dead weight that looks like it works.
    const shapes = CACHE_TAGS_DECLARED_BY_THE_STOREFRONT.map((t) =>
      t.replace(/<[a-zA-Z]+>/, "(.+)")
    ).map((t) => new RegExp(`^${t}$`))

    const produced = [
      ...((await run("product.updated", { id: "p" }, "h")) ?? []),
      ...((await run("offer.created", { id: "o", product_id: "p" }, "h")) ?? []),
      ...((await run("product.product-category.updated", { id: "c" }, "h")) ?? []),
      ...((await run("product.product-collection.updated", { id: "c" }, "h")) ?? []),
    ]

    for (const tag of new Set(produced)) {
      expect([tag, shapes.some((re) => re.test(tag))]).toEqual([tag, true])
    }
  })
})
