/**
 * Which payment providers a seeded region should offer.
 *
 * A region only offers the providers named on it, so this has to agree with the
 * `PAYMENTS` switch in `deploy/medusa-config.production.ts`. When they disagree the
 * failure is quiet and confusing: Stripe keys are set, the module loads, the boot guard
 * passes — and no customer can select Stripe at checkout, because the region was seeded
 * without it.
 *
 * The stub always stays. Removing it from a live region would strand any in-flight
 * payment session that referenced it, and it costs nothing to leave in.
 */
export function paymentProvidersFor(paymentsEnv: string | undefined): string[] {
  const enabled = (paymentsEnv || "stub")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)

  return [
    "pp_system_default",
    // Medusa names a provider `pp_<provider id>_<provider id>`; the Stripe provider is
    // registered with id `stripe`, so the region must reference `pp_stripe_stripe`.
    ...(enabled.includes("stripe") ? ["pp_stripe_stripe"] : []),
  ]
}
