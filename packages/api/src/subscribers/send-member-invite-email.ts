import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { MemberInviteWorkflowEvents } from "@mercurjs/core/workflows"

type MemberInviteCreated = {
  id: string
  token?: string
  expires_at?: string
}

/**
 * Sends the seller invitation email.
 *
 * Mercur ships every piece of this except the wiring. `createMemberInvitesWorkflow`
 * (behind POST /admin/sellers/:id/members/invite) creates the invite and emits
 * `member_invite.created`. `sendSellerInvitationEmailStep` knows how to build and send
 * the email. But nothing listens for that event, and the workflow that calls the step —
 * `inviteSellerWorkflow` — is exported and never invoked by any route.
 *
 * The result is an invite that is created and recorded, an API that returns 201, and a
 * seller who is never told. This subscriber is the missing link between the two halves.
 *
 * It needs a notification provider to be configured to do anything; see EMAIL_PROVIDER
 * in deploy/.env.example. With none configured the send throws, which is why the failure
 * is caught and logged rather than left to bubble: an email that cannot be sent must not
 * roll back an invitation that was legitimately created.
 */
export default async function sendMemberInviteEmailHandler({
  event,
  container,
}: SubscriberArgs<MemberInviteCreated | MemberInviteCreated[]>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const notificationService = container.resolve(Modules.NOTIFICATION)

  const invites = Array.isArray(event.data) ? event.data : [event.data]

  for (const invite of invites) {
    if (!invite?.id) {
      continue
    }

    try {
      // The event carries only id/token/expires_at, so the recipient has to be read
      // back. `select` is explicit for the reason documented all over this repo: a
      // module list call that is not told which fields it needs can return id-only rows,
      // and the email address would silently be undefined.
      const { data } = await query.graph({
        entity: "member_invite",
        fields: ["id", "email", "token", "seller_id"],
        filters: { id: invite.id },
      })

      const record = data?.[0]
      if (!record?.email) {
        logger.warn(
          `[member-invite-email] invite ${invite.id} has no email address; nothing sent.`
        )
        continue
      }

      const token = record.token ?? invite.token
      const base = process.env.MERCUR_VENDOR_URL?.replace(/\/$/, "")
      const registrationUrl =
        base && token ? `${base}/invite?token=${encodeURIComponent(token)}` : undefined

      await notificationService.createNotifications({
        to: record.email,
        channel: "email",
        template: "newSellerInvitation",
        data: { email: record.email, registration_url: registrationUrl },
        content: {
          subject: "You've been invited to sell on our marketplace",
          html: buildInvitationHtml(record.email, registrationUrl),
        },
      })

      logger.info(`[member-invite-email] invitation sent to ${record.email}`)
    } catch (error) {
      // Deliberately swallowed. The invitation itself is already created and valid, and
      // an operator can resend it; throwing here would fail the event handler and, worse,
      // make a working invite look like a failed one.
      logger.error(
        `[member-invite-email] could not send invitation for ${invite.id}: ` +
          `${(error as Error).message}. Is EMAIL_PROVIDER configured?`
      )
    }
  }
}

/**
 * The address and the URL are interpolated into markup, so both have to be escaped.
 * Neither is trusted: the address is whatever the operator typed into the invite form,
 * and the URL's origin comes from MERCUR_VENDOR_URL. Unescaped, a `<` or a quote in
 * either one breaks out of its context and injects markup into the outgoing email.
 * Ampersand first, or the escapes escape each other.
 */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Mirrors the markup in Mercur's own sendSellerInvitationEmailStep so the email looks the
 * same whether it is sent from here or from that workflow, should a future release start
 * calling it.
 */
export function buildInvitationHtml(email: string, registrationUrl?: string) {
  const safeEmail = escapeHtml(email)
  const cta = registrationUrl
    ? `<tr>
        <td style="padding: 24px 0 0;">
          <a href="${escapeHtml(registrationUrl)}" style="display:inline-block;background-color:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">Create your seller account</a>
        </td>
      </tr>`
    : ""

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;padding:40px;">
          <tr>
            <td style="font-size:20px;font-weight:600;color:#18181b;padding-bottom:16px;">
              You've been invited to sell on our marketplace
            </td>
          </tr>
          <tr>
            <td style="font-size:14px;color:#52525b;line-height:1.6;">
              An invitation has been sent to <strong>${safeEmail}</strong> to join as a seller. You can set up your store, list products, and start selling.
            </td>
          </tr>
          ${cta}
          <tr>
            <td style="font-size:12px;color:#a1a1aa;padding-top:32px;border-top:1px solid #e4e4e7;">
              If you did not expect this invitation, you can ignore this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export const config: SubscriberConfig = {
  event: MemberInviteWorkflowEvents.CREATED,
  context: { subscriberId: "send-member-invite-email" },
}
