import {
  AbstractNotificationProviderService,
  MedusaError,
} from "@medusajs/framework/utils"
import { Logger, NotificationTypes } from "@medusajs/framework/types"

type InjectedDependencies = { logger: Logger }

export type ResendNotificationOptions = {
  /** Resend API key. */
  api_key: string
  /**
   * The From address. Resend rejects anything not on a domain verified in the
   * account, so until a domain is added this has to be onboarding@resend.dev —
   * which in turn can only deliver to the address that owns the account.
   */
  from: string
  /** Optional Reply-To, for replies from sellers and customers. */
  reply_to?: string
  /** Overridable for tests. */
  base_url?: string
}

const RESEND_API = "https://api.resend.com"
const SEND_TIMEOUT_MS = 10_000

/**
 * Sends the marketplace's transactional email through Resend.
 *
 * Deliberately talks to the REST API with `fetch` rather than using the `resend` SDK.
 * The SDK peer-depends on @react-email/render, which pulls react-dom 19 and therefore
 * react 19, and this project pins react 18.3.1 for the panels. That conflict is
 * survivable in the builder stage, which already installs with --force for unrelated
 * reasons, but the runtime artifact installs without it and fails outright with
 * ERESOLVE. Sending an email is one POST; it is not worth a react-version conflict, a
 * larger image, or weakening the artifact install.
 *
 * Mercur builds its own message bodies — sendSellerInvitationEmailStep passes
 * `content.subject` and `content.html` already rendered — so this takes what it is given
 * rather than templating anything.
 */
export class ResendNotificationService extends AbstractNotificationProviderService {
  static identifier = "resend"

  private options: ResendNotificationOptions
  private logger: Logger

  constructor({ logger }: InjectedDependencies, options: ResendNotificationOptions) {
    super()
    this.options = options
    this.logger = logger
  }

  /**
   * Medusa calls this at boot so a misconfiguration surfaces on startup rather than the
   * first time somebody invites a seller — by which point the invitation exists and the
   * person is expecting an email.
   */
  static validateOptions(options: Record<string, unknown>) {
    const missing = [!options.api_key && "api_key", !options.from && "from"].filter(
      Boolean
    )

    if (missing.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Resend notification provider is missing: ${missing.join(", ")}`
      )
    }
  }

  async send(
    notification: NotificationTypes.ProviderSendNotificationDTO
  ): Promise<NotificationTypes.ProviderSendNotificationResultsDTO> {
    if (!notification?.to) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Resend provider received a notification with no recipient."
      )
    }

    const subject = notification.content?.subject
    const html = notification.content?.html

    // Refuse rather than send an empty message. A blank email is worse than none: the
    // recipient gets something useless and every layer above reports success, so the
    // failure surfaces only as a confused person asking why their invitation is empty.
    if (!subject || !html) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Resend provider got no ${!subject ? "subject" : "html body"} for template ` +
          `"${notification.template}" to ${notification.to}. Mercur renders these itself, ` +
          `so an empty one means the sending workflow changed shape.`
      )
    }

    const base = this.options.base_url ?? RESEND_API

    let response: Response
    try {
      response = await fetch(`${base}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [notification.to],
          subject,
          html,
          // The REST API uses snake_case here; the SDK's camelCase `replyTo` is silently
          // ignored by it.
          ...(this.options.reply_to ? { reply_to: this.options.reply_to } : {}),
        }),
        // Without a deadline a hung API pins this handler open on every send.
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
    } catch (error) {
      const message = (error as Error).message
      this.logger.error(
        `[resend] could not reach the API for "${notification.template}" to ${notification.to}: ${message}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Could not reach Resend: ${message}`
      )
    }

    // fetch only rejects on transport failure, so a rejected send — an unverified From
    // address is the common one — arrives here as a perfectly ordinary response. Without
    // this check it would be recorded as delivered.
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      this.logger.error(
        `[resend] rejected "${notification.template}" to ${notification.to}: ` +
          `${response.status} ${detail}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Resend rejected the email (${response.status}): ${detail}`
      )
    }

    const body = (await response.json().catch(() => ({}))) as { id?: string }

    this.logger.info(
      `[resend] sent "${notification.template}" to ${notification.to} (id ${body.id})`
    )

    return { id: body.id }
  }
}
