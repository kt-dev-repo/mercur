import { paymentProvidersFor } from "../payment-providers"

// This list and the PAYMENTS switch in deploy/medusa-config.production.ts have to agree.
// When they drift the deployment looks configured and simply cannot take money: the
// module loads, the boot guard passes, and Stripe is absent from the region so no
// customer can select it. That failure is invisible until someone tries to check out.
describe("paymentProvidersFor", () => {
  it("offers only the stub by default", () => {
    expect(paymentProvidersFor(undefined)).toEqual(["pp_system_default"])
    expect(paymentProvidersFor("stub")).toEqual(["pp_system_default"])
  })

  it("adds Stripe when it is enabled", () => {
    expect(paymentProvidersFor("stripe")).toContain("pp_stripe_stripe")
  })

  it("keeps the stub alongside Stripe", () => {
    // Dropping it from a live region would strand any in-flight payment session that
    // referenced it, and it costs nothing to leave in.
    expect(paymentProvidersFor("stripe")).toContain("pp_system_default")
  })

  it("reads a comma-separated list, with or without spaces", () => {
    expect(paymentProvidersFor("stub,stripe")).toContain("pp_stripe_stripe")
    expect(paymentProvidersFor(" stub , stripe ")).toContain("pp_stripe_stripe")
  })

  it("does not match a provider by accident", () => {
    // "stripe-connect" is the payout provider, not the payment one; only an exact
    // entry should switch on the payment provider.
    expect(paymentProvidersFor("stripe-connect")).toEqual(["pp_system_default"])
  })
})
