const runWorkflow = jest.fn()

jest.mock("@mercurjs/core/workflows", () => ({
  getOrderGroupDetailWorkflow: () => ({ run: runWorkflow }),
}))

import handler from "../send-order-confirmation-email"

// The receipt markup is covered next door. These cover the handler: that it sends one
// email for the whole purchase, that it does not send one it cannot address, and that a
// failure never propagates into a checkout that already succeeded.

const group = (over: Record<string, unknown> = {}) => ({
  id: "ogrp_1",
  display_id: 12,
  total: 4000,
  currency_code: "eur",
  cart: { email: "shopper@example.com" },
  orders: [
    { id: "o1", display_id: 1, total: 2000, currency_code: "eur", items: [], seller: { name: "Alpha" } },
    { id: "o2", display_id: 2, total: 2000, currency_code: "eur", items: [], seller: { name: "Beta" } },
  ],
  ...over,
})

const makeContainer = (overrides: Record<string, unknown> = {}) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const notificationService = {
    createNotifications: jest.fn().mockResolvedValue({}),
    ...(overrides.notificationService as object),
  }
  return {
    logger,
    notificationService,
    container: {
      resolve: (key: string) => (key === "logger" ? logger : notificationService),
    },
  }
}

const run = async (data: unknown, c: ReturnType<typeof makeContainer>) =>
  handler({ event: { data } as never, container: c.container as never } as never)

describe("order confirmation subscriber", () => {
  beforeEach(() => {
    runWorkflow.mockReset()
    runWorkflow.mockResolvedValue({ result: group() })
  })

  it("sends exactly one email for a multi-seller purchase", async () => {
    // Not one per seller. Subscribing to order.placed instead of order_group.created
    // would send two here, and neither would show the whole basket.
    const c = makeContainer()
    await run({ id: "ogrp_1" }, c)

    expect(c.notificationService.createNotifications).toHaveBeenCalledTimes(1)
    const arg = c.notificationService.createNotifications.mock.calls[0][0]
    expect(arg).toMatchObject({ to: "shopper@example.com", template: "orderConfirmation" })
    expect(arg.data).toMatchObject({ seller_count: 2, seller_names: ["Alpha", "Beta"] })
  })

  it("keys on the order group so a redelivered event cannot send a second receipt", async () => {
    const c = makeContainer()
    await run({ id: "ogrp_1" }, c)
    await run({ id: "ogrp_1" }, c)

    const keys = c.notificationService.createNotifications.mock.calls.map(
      (call: [{ idempotency_key: string }]) => call[0].idempotency_key
    )
    expect(keys[0]).toEqual("order-confirmation-ogrp_1")
    expect(keys[0]).toEqual(keys[1])
  })

  it("sends nothing when there is no address to send to", async () => {
    // A guest checkout may have no customer record at all; the cart's email is the only
    // recipient there is. Missing one is not an error worth throwing — the order is fine.
    runWorkflow.mockResolvedValue({ result: group({ cart: null }) })
    const c = makeContainer()
    await run({ id: "ogrp_1" }, c)

    expect(c.notificationService.createNotifications).not.toHaveBeenCalled()
    expect(c.logger.warn).toHaveBeenCalled()
  })

  it("sends nothing when the event carries no order group id", async () => {
    const c = makeContainer()
    await run({}, c)

    expect(runWorkflow).not.toHaveBeenCalled()
    expect(c.notificationService.createNotifications).not.toHaveBeenCalled()
  })

  it("does not throw when the order group cannot be loaded", async () => {
    // The order is placed and paid. An unhandled rejection here would surface as a
    // checkout error for a checkout that actually succeeded.
    runWorkflow.mockRejectedValue(new Error("boom"))
    const c = makeContainer()

    await expect(run({ id: "ogrp_1" }, c)).resolves.toBeUndefined()
    expect(c.logger.error).toHaveBeenCalled()
  })

  it("does not throw when delivery fails", async () => {
    const c = makeContainer({
      notificationService: {
        createNotifications: jest.fn().mockRejectedValue(new Error("no provider")),
      },
    })

    await expect(run({ id: "ogrp_1" }, c)).resolves.toBeUndefined()
    expect(c.logger.error).toHaveBeenCalled()
  })

  it("still sends when a seller name is missing", async () => {
    // Degrades to the order number rather than dropping the receipt.
    runWorkflow.mockResolvedValue({
      result: group({
        orders: [{ id: "o1", display_id: 1, total: 2000, currency_code: "eur", items: [], seller: null }],
      }),
    })
    const c = makeContainer()
    await run({ id: "ogrp_1" }, c)

    expect(c.notificationService.createNotifications).toHaveBeenCalledTimes(1)
    expect(c.notificationService.createNotifications.mock.calls[0][0].data.seller_names).toEqual([])
  })
})
