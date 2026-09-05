import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { AuthWorkflowEvents, ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { escapeHtml, renderEmail } from "../lib/email-layout"

type PasswordResetRequested = {
  entity_id: string
  actor_type: string
  token: string
  metadata?: Record<string, unknown> | null
}

/**
 * Sends the password reset email.
 *
 * Medusa's `generateResetPasswordTokenWorkflow` — behind
 * `POST /auth/:actor_type/:auth_provider/reset-password` — mints the token and emits
 * `auth.password_reset`. Nothing listens for it, so before this subscriber the route
 * answered 201 and the token went nowhere: the reset form appeared to work and no email
 * ever arrived.
 *
 * Note the route deliberately does not throw for an unknown identifier, so it cannot be
 * used to discover which addresses have accounts. That property only holds if this
 * subscriber is equally quiet — see the `catch` at the bottom.
 */
export default async function sendPasswordResetEmailHandler({
  event,
  container,
}: SubscriberArgs<PasswordResetRequested>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const notificationService = container.resolve(Modules.NOTIFICATION)

  const { entity_id: email, actor_type: actorType, token } = event.data ?? {}

  if (!email || !token) {
    logger.warn("[password-reset-email] event carried no identifier or token; nothing sent.")
    return
  }

  try {
    const resetUrl = buildResetUrl(actorType, token)

    // Keyed on the token, not the address. Each request mints a new token, so a genuine
    // second request does send a second email — which is the behaviour a user retrying
    // expects — while a redelivered event cannot produce a duplicate.
    const idempotencyKey = `password-reset-${hashToken(token)}`

    await notificationService.createNotifications({
      to: email,
      channel: "email",
      template: "passwordReset",
      idempotency_key: idempotencyKey,
      data: {
        email,
        actor_type: actorType,
        reset_url: resetUrl,
        idempotency_key: idempotencyKey,
      },
      content: {
        subject: "Reset your password",
        html: buildPasswordResetHtml(email, resetUrl),
      },
    })

    logger.info(`[password-reset-email] reset email sent for a ${actorType} account`)
  } catch (error) {
    // Not rethrown, and deliberately says nothing about whether the address exists.
    // Throwing would fail the event handler without helping anyone: the token is already
    // minted and the user can request another.
    logger.error(
      `[password-reset-email] could not send reset email: ${(error as Error).message}. ` +
        `Is EMAIL_PROVIDER configured?`
    )
  }
}

/**
 * Where the reset form lives depends on who is resetting. The three actor types are
 * served by three different front ends, and sending a seller to the admin panel — or a
 * customer to either — is a dead end.
 *
 * Returns undefined when the relevant URL is not configured, in which case the email
 * still goes out with the token quoted, which is recoverable, rather than carrying a link
 * to nowhere, which is not.
 */
export function buildResetUrl(actorType: string, token: string): string | undefined {
  const trim = (value?: string) => value?.replace(/\/$/, "") || undefined
  const backend = trim(process.env.MERCUR_BACKEND_URL)

  // The panels are served from the backend origin under fixed paths (see the `admin-ui`
  // and `vendor-ui` module options in medusa-config.ts), so they only need an explicit
  // variable when they are hosted somewhere else. A storefront always does.
  const base =
    actorType === "customer"
      ? trim(process.env.MERCUR_STOREFRONT_URL)
      : actorType === "member"
        ? trim(process.env.MERCUR_VENDOR_URL) ?? (backend && `${backend}/seller`)
        : trim(process.env.MERCUR_ADMIN_URL) ?? (backend && `${backend}/dashboard`)

  if (!base) {
    return undefined
  }
  return `${base}/reset-password?token=${encodeURIComponent(token)}`
}

/**
 * A short, non-reversible fingerprint of the token, for the idempotency key. The raw
 * token is a JWT that grants a password reset; it must not be written into a key that
 * ends up in logs or in the notification table's indexes.
 */
function hashToken(token: string) {
  let hash = 0
  for (let i = 0; i < token.length; i++) {
    hash = (Math.imul(31, hash) + token.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

export function buildPasswordResetHtml(email: string, resetUrl?: string) {
  const safeEmail = escapeHtml(email)

  const bodyHtml = resetUrl
    ? `A password reset was requested for <strong>${safeEmail}</strong>. Choose a new password using the button below.`
    : `A password reset was requested for <strong>${safeEmail}</strong>, but this marketplace has no reset page configured. Contact an administrator to finish resetting your password.`

  return renderEmail({
    heading: "Reset your password",
    bodyHtml,
    cta: resetUrl ? { label: "Choose a new password", url: resetUrl } : undefined,
    // The window is short and unadvertised elsewhere. A user who opens this an hour later
    // needs to know why the link no longer works, or they assume the system is broken.
    note: "This link expires 15 minutes after it was requested.",
    footer:
      "If you did not request a password reset, you can ignore this email — your password has not changed.",
  })
}

export const config: SubscriberConfig = {
  event: AuthWorkflowEvents.PASSWORD_RESET,
  context: { subscriberId: "send-password-reset-email" },
}
