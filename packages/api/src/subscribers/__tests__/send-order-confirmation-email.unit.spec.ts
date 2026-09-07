import { buildOrderConfirmationHtml } from "../send-order-confirmation-email"

const order = (over: Record<string, unknown> = {}) => ({
  id: "order_1",
  display_id: 7,
  total: 2000,
  currency_code: "eur",
  items: [{ title: "Widget", quantity: 2, total: 2000 }],
  seller: { name: "Alpha Store" },
  ...over,
})

describe("buildOrderConfirmationHtml", () => {
  it("groups the receipt by seller, because that is how it will arrive", () => {
    const html = buildOrderConfirmationHtml(
      12,
      [order(), order({ id: "order_2", seller: { name: "Beta Store" } })],
      4000,
      "eur"
    )

    expect(html).toContain("Sold by Alpha Store")
    expect(html).toContain("Sold by Beta Store")
  })

  it("warns that a multi-seller order arrives in separate deliveries", () => {
    const many = buildOrderConfirmationHtml(12, [order(), order({ id: "order_2" })], 4000, "eur")
    expect(many).toContain("2 sellers")
    expect(many).toContain("separate deliveries")

    // One seller, one parcel — the warning would be noise.
    const one = buildOrderConfirmationHtml(12, [order()], 2000, "eur")
    expect(one).not.toContain("separate deliveries")
  })

  it("escapes a seller name rather than trusting it as markup", () => {
    // Seller names are attacker-controlled: anyone who registers a store picks one.
    const html = buildOrderConfirmationHtml(
      1,
      [order({ seller: { name: "<script>alert(1)</script>" } })],
      2000,
      "eur"
    )

    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("escapes product titles too", () => {
    const html = buildOrderConfirmationHtml(
      1,
      [order({ items: [{ title: "<img src=x onerror=alert(1)>", quantity: 1, total: 100 }] })],
      100,
      "eur"
    )

    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;img src=x")
  })

  it("falls back to the order number when a seller name is missing", () => {
    const html = buildOrderConfirmationHtml(1, [order({ seller: null })], 2000, "eur")

    expect(html).toContain("Order #7")
  })

  it("formats money in the order's own currency", () => {
    const html = buildOrderConfirmationHtml(1, [order()], 2000, "eur")

    // The symbol and its placement follow the currency rather than being assumed.
    expect(html).toMatch(/€|EUR/)
  })

  it("renders totals whichever shape Medusa hands back", () => {
    // Medusa types money as BigNumberValue — BigNumberJS | number | string | IBigNumber —
    // so query.graph may return a string or a BigNumber-like object. A `typeof === number`
    // guard dropped every price in those cases and still sent a clean-looking receipt with
    // no line prices, no subtotal and no total. Each shape must render identically.
    const shapes: Record<string, unknown> = {
      number: 2000,
      string: "2000",
      bigNumberLike: { valueOf: () => 2000, toString: () => "2000" },
    }

    for (const [name, value] of Object.entries(shapes)) {
      const html = buildOrderConfirmationHtml(
        1,
        [order({ total: value, items: [{ title: "Widget", quantity: 2, total: value }] })],
        value as never,
        "eur"
      )

      expect([name, html.includes(">Total<")]).toEqual([name, true])
      expect([name, html.includes("Subtotal")]).toEqual([name, true])
      // 2000 major units in EUR, formatted by Intl — the same for all three shapes.
      // Intl may use a comma, a dot, or a narrow/non-breaking space as the group separator.
      expect([name, /2[,.\u00a0\u202f\s]000/.test(html)]).toEqual([name, true])
    }
  })

  it("prints a zero total rather than omitting it", () => {
    // 0 is a real amount — a fully discounted order — and must not be confused with
    // "no total was supplied", which is the only case that renders nothing.
    const html = buildOrderConfirmationHtml(1, [order({ total: 0 })], 0, "eur")

    expect(html).toContain(">Total<")
  })

  it("does not invent a total it was not given", () => {
    const html = buildOrderConfirmationHtml(1, [order({ total: undefined })], undefined, "eur")

    expect(html).not.toContain(">Total<")
    expect(html).not.toContain("undefined")
  })

  it("still renders a receipt for an order group with no display id", () => {
    const html = buildOrderConfirmationHtml(undefined, [order()], 2000, "eur")

    expect(html).toContain("Your order is confirmed")
    expect(html).not.toContain("#undefined")
  })
})
