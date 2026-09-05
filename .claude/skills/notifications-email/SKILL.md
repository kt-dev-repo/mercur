---
name: notifications-email
description: Add or change a transactional email — a subscriber, a template, or the notification provider. Use when an event should send mail, when an email is not arriving, or when touching src/subscribers or src/modules/resend. Covers escaping, idempotency, retry, and the failure mode where everything looks fine and nobody is told.
---

# Transactional email

Every email here is the same three pieces: an **event** that already fires, a
**subscriber** that listens, and a **provider** that delivers. Mercur and Medusa emit the
events; before this project wrote the subscribers, nothing listened, and each feature
looked like it worked while telling nobody.

| Email | Event | Subscriber |
|---|---|---|
| Seller invitation | `member_invite.created` | `send-member-invite-email.ts` |
| Password reset | `auth.password_reset` | `send-password-reset-email.ts` |
| Order confirmation | `order_group.created` | `send-order-confirmation-email.ts` |

`EMAIL_PROVIDER` selects `none` (default), `local`, or `resend`. One provider per channel
is a Medusa constraint, so it is a choice, not a stack.

## The failure this exists to prevent

**A missing email is invisible.** The API returns 201, a row exists, and the person is
never told. Assume every change can fail this way and design against it.

## Rules

**1. Escape everything interpolated into markup.** Addresses come from forms, store and
product names from sellers, URL origins from environment variables. None is trusted.
Use `escapeHtml` from `src/lib/email-layout.ts`; ampersand first, or the escapes escape
each other.

**2. Never rethrow a delivery failure.** The invitation is already created, the token
already minted, the order already paid. Throwing fails the handler without getting anyone
their email — and an unhandled rejection surfaces as an error for an operation that
succeeded. Log it, and where there is somewhere to record it, record it (the invitation
writes `email_delivery` / `email_error` to the invite's `metadata`, because a log line
alone is invisible to the operator who saw a 201).

**3. Idempotency keys must not carry credentials.** The key is a unique column and reaches
logs and indexes. Key on a stable id (`order-confirmation-${group.id}`) or a
non-reversible fingerprint — never a raw token. A redelivered event must not send a second
email; a genuinely new request must send one.

**4. Do not leak whether an account exists.** Password reset returns 201 for unknown
addresses so it cannot be used to enumerate accounts. A log line naming the address
defeats that. Say nothing identifying on the failure path.

**5. Put anything that fails soft into `data`.** `content` is **not persisted** by the
notification module; `data` is. A seller-name lookup that degrades to "Order #12" leaves
every test green while every email goes out anonymous. Persist it, then assert it.

## The provider

`src/modules/resend/` talks to the REST API with `fetch` and has **no dependencies**. Do
not add the `resend` SDK — it peer-depends on React 19, which conflicts with the pinned
React 18.3.1 and breaks the runtime artifact install.

It retries three times on 429, 5xx and transport failures, honouring `Retry-After`
(Resend allows ~2 requests/second, so inviting a team hits a 429). A 4xx fails at once: a
rejection will reject again. Recipients are masked in its logs.

Mercur renders subject and HTML itself, so the provider takes what it is given and refuses
a notification with neither.

## Testing

Unit-test the pure pieces (URL building, markup, escaping) and the handler separately —
the handler tests are where refusals and failure paths belong. See
`src/subscribers/__tests__/*.handler.unit.spec.ts`.

Integration tests assert the notification reaches `status: "success"`, which is what
separates *delivered* from merely *recorded*: the row is written before a provider ever
sees it, so with none configured every other assertion still passes. Wait for a **settled**
row, not merely an existing one — see the `backend-testing` skill.

`EMAIL_PROVIDER=local` logs to the container output and proves the whole path with no
account. Do that before reaching for real credentials.
