---
name: payments
description: Change how the marketplace takes money or pays sellers — the PAYMENTS switch, the Stripe payment and payout providers, webhooks, or the seeded region providers. Use before adding a payment provider, touching capture behaviour, or debugging a checkout that completes without charging.
---

# Payments and payouts

**The default takes no money.** `PAYMENTS=stub` wires regions to `pp_system_default`, a
stub that authorises everything and charges nothing. Checkout completes, an order appears,
no card is touched.

```
PAYMENTS=stub               # default
PAYMENTS=stripe             # cards and Connect payouts
PAYMENTS=stub,stripe        # comma-separated: several providers per region
```

It is a **list**, not a choice. Medusa allows several payment providers per region and
Stripe does not acquire everywhere — Cambodia needs ABA PayWay (see
`PLAN-aba-payway-khqr.md`). A second provider should be a config change, not a rewrite.

## Stripe is two integrations

| | Package | Webhook |
|---|---|---|
| Charging customers | `@medusajs/medusa/payment-stripe` | `/hooks/payment/stripe_stripe` |
| Paying sellers | `@mercurjs/payout-stripe-connect` | `/hooks/payout` |

Mercur uses Stripe's separate charges and transfers model: the platform collects the full
payment and then transfers to each seller's connected account. **That makes the platform
the merchant of record** — responsible for VAT, disputes and chargebacks.

## Rules

**1. `capture: false` is mandatory.** Capturing at authorisation takes the whole amount
before the split is known and breaks the payout to sellers. The payout module captures
later, once fulfilment allows it. This is the easiest thing here to get wrong and the most
expensive to discover in production.

**2. The two webhook secrets are different.** Stripe signs each endpoint with its own.
Reusing one means the other fails signature verification and drops every event it
receives, silently. The boot guard requires both separately for that reason.

**3. Trust the installed source over the documentation.** Two bugs came from following
Mercur's Stripe Connect guide:

- the option is **`automaticPaymentMethods`** (camelCase). The documented
  `automatic_payment_methods` is ignored silently by `payment-stripe` 2.18.0, leaving
  intents without automatic payment methods while looking configured
- `defineConfig` validates shape only — a wrong `resolve` string loads fine and fails at
  boot. Check paths with `require.resolve`

**4. A region only offers the providers named on it.** `paymentProvidersFor` in
`src/lib/payment-providers.ts` decides that list, and the seed reconciles it against
`listPaymentProviders()`. Without reconciliation, `PAYMENTS=stripe` in development — where
the production overlay is not used and the provider is not registered — kills the seed
with `Payment providers with ids pp_stripe_stripe not found or not enabled`. A mismatch
warns loudly; it must never silently vanish, or the deployment believes it takes cards and
does not.

Provider ids are `pp_${identifier}_${id}`, so the Stripe provider registered with
`id: 'stripe'` is `pp_stripe_stripe`. `pp_system_default` is registered unconditionally by
the payment module, so it always exists and is safe to keep on a region.

**5. Write `accountValidation` out explicitly.** Those five conditions decide when a
connected account becomes `ACTIVE` and may receive money. They match the provider's
defaults, spelled out so that loosening them is a deliberate act — paying out to an
account with outstanding requirements is how funds end up stuck.

## Verifying

Test keys (`sk_test_`) exercise the whole flow. Enable Connect first — **Settings →
Connect settings** — or seller onboarding has nothing to create accounts against.

End to end means: a two-seller cart through checkout produces an order group with a
payment intent per seller, webhooks are delivered (the Stripe CLI is the easy path), and a
connected account reaches `ACTIVE`.
