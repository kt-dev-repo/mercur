# Study — ABA PayWay and KHQR as a second payment provider

Status: **research only, nothing built.** Written 2026-09-05 from ABA's published API
documentation. No sandbox account has been opened, so nothing here has been executed —
every claim is "the documentation says", not "I saw it work".

See `PLAN-development-stages.md` for the Stripe work (Stage 2a) this would sit beside.

## Why this is worth writing down

Stripe does not acquire in Cambodia. A marketplace selling there needs a local acquirer,
and ABA Bank's PayWay is the dominant one — it fronts **KHQR**, the National Bank of
Cambodia's interoperable QR standard, which reaches every Bakong-connected wallet rather
than just ABA's own customers. For a domestic buyer, KHQR is the payment method, in the
way cards are elsewhere.

So this is not a Stripe alternative to choose between. It is a *second* provider, for a
different market, and that shapes how Stage 2a should be built even if PayWay is never
added.

## What the documentation establishes

Read from ABA's Developer Suite and the mirrored API reference. Endpoint-level detail is
in the sources at the bottom.

### Credentials and signing

Three things are issued by ABA: a `merchant_id`, an **API key** used for hashing, and an
**RSA public key** used to encrypt sensitive fields on some endpoints.

Every request is signed:

```
hash = base64_encode(hash_hmac('sha512', <concatenated params>, api_key, true))
```

The concatenation is **positional and endpoint-specific** — the order differs from the
order the parameters are documented in, and a field that is absent still occupies its
place. This is the single most likely source of integration pain: a wrong hash returns
error code `5` and nothing about which field was misplaced.

### Environments

| | |
|---|---|
| Sandbox | `https://checkout-sandbox.payway.com.kh/` |
| Production | `https://checkout.payway.com.kh/` |

Two constraints that will bite before any code is wrong:

- **The calling domain/IP must be whitelisted by ABA in advance.** An unapproved origin
  gets error code `6: wrong domain`. This cannot be self-served, so it has the same lead
  time as the Resend DNS verification did.
- **Every endpoint is POST.** A `GET` returns `405`.

### Taking a KHQR payment

`POST /api/payment-gateway/v1/payments/generate-qr` returns a `qrString`, a `qrImage`
(base64 PNG) and an `abapay_deeplink` for handing off to the app on mobile. The merchant
sets `lifetime` for expiry and passes a base64-encoded `callback_url`.

There is also a hosted checkout (`01-purchase.md`) that covers KHQR, cards, WeChat Pay
and Alipay behind one redirect. **That is the one to start with**: it avoids rendering and
polling QR state, and it is what ABA's own WooCommerce and PrestaShop plugins use.

### Confirming that money arrived — the part that matters

PayWay `POST`s a JSON notification to a merchant webhook containing `transaction_id`,
`merchant_ref`, `payment_status_code` (`0` = success), `payment_status` (`"APPROVED"`),
`original_amount` / `original_currency`, and bank reference fields.

> **The published KHQR guideline describes no signature, HMAC or shared secret on that
> webhook.** Nothing in the documented payload proves ABA sent it.

Treat the webhook as an *untrusted hint that something happened*, never as proof of
payment. On receipt, call
`POST /api/payment-gateway/v1/payments/check-transaction-2` — signed with
`req_time . merchant_id . tran_id` — and believe only its answer:

| `payment_status` | Code | Meaning |
|---|---|---|
| `APPROVED` | `0` | paid in full |
| `PENDING` | `2` | awaiting the payer |
| `DECLINED` | `3` | declined |
| `REFUNDED` | `4` | refunded, full or partial |
| `CANCELLED` | `7` | closed or pre-auth cancelled |

Anyone who can guess a `tran_id` can otherwise mark an order paid. Since the transaction
id is ours to choose, it should be unguessable for that reason alone.

The status check covers only the **last 7 days**; `03-get-transaction-details.md` is the
route for anything older, which matters for reconciliation but not for checkout.

### What exists beyond checkout

Refunds (`06`, full and partial), pre-authorisation capture/cancel (`17`–`19`), card
tokenisation (`08`–`13`), and beneficiary payouts (`20`–`23`). The payout endpoints are
the interesting ones for a marketplace: they are the shape of a seller settlement, but
whether they support a Stripe-Connect-style split is **not established** — that needs the
sandbox and, realistically, a conversation with ABA.

## What this means for the Stripe work, today

The useful conclusion is not "build PayWay". It is: **do not let Stage 2a assume there is
exactly one payment provider.**

Concretely, and at no extra cost while writing 2a:

1. **`PAYMENTS` is a list, not a boolean.** The plan already specifies
   `PAYMENTS=stub|stripe`. Make the parser accept a comma-separated set so
   `PAYMENTS=stripe,payway` is a configuration change rather than a rewrite. Medusa
   supports several payment providers per region; the seed already writes
   `payment_providers` as an array.
2. **Boot guards are per-provider.** The Resend guard names every missing variable for the
   provider that is enabled. Same shape here, so enabling PayWay later names
   `PAYWAY_MERCHANT_ID`, `PAYWAY_API_KEY`, `PAYWAY_BASE_URL` without touching Stripe's.
3. **Webhook routes are per-provider and independent.** Stripe verifies a signature;
   PayWay cannot. Keep "did this really happen" inside each provider rather than in shared
   checkout code, or the weaker provider's trust model leaks into the stronger one's.
4. **Do not model payment capture on Stripe alone.** `capture: false` is mandatory for
   Stripe Connect; PayWay's equivalent is the pre-auth endpoints, and its payout model is
   unknown. Keep the marketplace's expectations expressed in Mercur's own payout module,
   not in Stripe-shaped assumptions scattered through the code.

## What would need answering before building it

Not blockers for Stripe; blockers for PayWay.

- [ ] Open a sandbox account (self-service; keys arrive by email) and get a domain
      whitelisted, since nothing can be called until that lands
- [ ] Confirm whether the webhook really has no authentication, or whether ABA issues a
      secret out of band that the public docs omit. This changes the security model
- [ ] Establish supported currencies. KHR and USD are both in daily use in Cambodia and
      the overview does not list them; a marketplace priced in USD needs this pinned
- [ ] Determine whether payouts can split a single payment across sellers, or whether
      settlement has to be a separate scheduled disbursement
- [ ] Check whether a Medusa v2 payment provider for PayWay already exists before writing
      one — the plugin ecosystem has WooCommerce and PrestaShop plugins, so a Medusa one
      may exist too

## Sources

- [ABA PayWay Developer Suite — Overview](https://developer.payway.com.kh/overview-865678m0)
- [ABA QR API](https://developer.payway.com.kh/aba-qr-api-3158158f0)
- [Ecommerce Checkout](https://developer.payway.com.kh/ecommerce-checkout-3158159f0)
- [API Integration — payway.com.kh](https://www.payway.com.kh/developers/general/)
- [Mirrored API reference (Joselay/aba-payway-docs)](https://github.com/Joselay/aba-payway-docs) —
  used for endpoint-level detail: [QR API](https://github.com/Joselay/aba-payway-docs/blob/main/14-qr-api.md),
  check-transaction, and the KHQR guideline

Production credentials come from ABA's merchant acquisition team (`paywaysales@ababank.com`),
not from the developer portal.
