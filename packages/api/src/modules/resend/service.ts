import {
  AbstractNotificationProviderService,
  MedusaError,
} from "@medusajs/framework/utils"
import { Logger, NotificationTypes } from "@medusajs/framework/types"
import { Resend } from "resend"

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
  /** Optional Reply-To for replies from sellers and customers. */
  reply_to?: string
}

/**
 * Sends the marketplace's transactional email through Resend.
 *
 * Mercur builds its own message bodies: sendSellerInvitationEmailStep calls
 * createNotifications with `content.subject` and `content.html` already rendered, and
 * passes `template` and `data` alongside for providers that would rather do their own
 * templating. This one takes what it is given, which keeps the email's wording in the
 * package that owns the feature rather than split across two repositories.
 */
export class ResendNotificationService extends AbstractNotificationProviderService {
  static identifier = "resend"

  private client: Resend
  private options: ResendNotificationOptions
  private logger: Logger

  constructor({ logger }: InjectedDependencies, options: ResendNotificationOptions) {
    super()
    this.options = options
    this.logger = logger
    this.client = new Resend(options.api_key)
  }

  /**
   * Medusa calls this to fail fast at boot rather than at send time. Without it a
   * missing key surfaces the first time someone invites a seller — by which point the
   * invitation row exists and the person is expecting an email.
   */
  static validateOptions(options: Record<string, unknown>) {
    const missing = [
      !options.api_key && "api_key",
      !options.from && "from",
    ].filter(Boolean)

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
    // recipient gets something useless, and every layer above reports success, so the
    // failure only surfaces as a confused person asking why their invitation is empty.
    if (!subject || !html) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Resend provider got no ${!subject ? "subject" : "html body"} for template ` +
          `"${notification.template}" to ${notification.to}. Mercur renders these itself, ` +
          `so an empty one means the sending workflow changed shape.`
      )
    }

    const { data, error } = await this.client.emails.send({
      from: this.options.from,
      to: [notification.to],
      subject,
      html: html as string,
      ...(this.options.reply_to ? { replyTo: this.options.reply_to } : {}),
    })

    // The SDK reports failures in the response rather than by throwing, so without this
    // check a rejected send returns cleanly and the notification is recorded as sent.
    if (error) {
      this.logger.error(
        `[resend] failed to send "${notification.template}" to ${notification.to}: ${error.message}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Resend rejected the email: ${error.message}`
      )
    }

    this.logger.info(
      `[resend] sent "${notification.template}" to ${notification.to} (id ${data?.id})`
    )

    return { id: data?.id }
  }
}
