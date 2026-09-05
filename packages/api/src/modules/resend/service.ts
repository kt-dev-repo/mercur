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
  /** Overridable for tests, which would otherwise sleep through the backoff. */
  retry_base_delay_ms?: number
}

const RESEND_API = "https://api.resend.com"
const SEND_TIMEOUT_MS = 10_000

/**
 * Three attempts total. Resend's free tier allows about two requests a second, and
 * inviting a team in one go walks straight into that — a 429 that nobody retries is an
 * invitation silently never sent.
 */
const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 500
/** Resend can ask for a longer wait than we are willing to hold the handler open for. */
const MAX_RETRY_DELAY_MS = 5_000

/** 429 and 5xx are worth another go; a 4xx is a rejection that will reject again. */
const isRetryableStatus = (status: number) => status === 429 || status >= 500

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Logs identify the recipient without printing the whole address. Every send is logged,
 * so the alternative is a permanent, greppable list of who uses this marketplace sitting
 * in the container output.
 */
const maskRecipient = (to: string) => {
  const at = to.lastIndexOf("@")
  if (at < 1) {
    return "***"
  }
  return `${to[0]}***${to.slice(at)}`
}

/**
 * `foo@bar.com` or `Name <foo@bar.com>`. Deliberately loose — this is here to catch a
 * misconfiguration at boot, not to adjudicate RFC 5322.
 */
const looksLikeFromAddress = (value: string) =>
  /^[^@<>\s]+@[^@<>\s.]+\.[^@<>\s]+$/.test(value.trim()) ||
  /^[^<>]*<[^@<>\s]+@[^@<>\s.]+\.[^@<>\s]+>$/.test(value.trim())

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

    // Presence is not enough. A malformed From boots clean and then fails at Resend on
    // the first real send — which is precisely the "configured but silently broken"
    // state this hook exists to prevent.
    const from = String(options.from)
    if (!looksLikeFromAddress(from)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Resend notification provider has a "from" that is not an email address: ` +
          `"${from}". Use marketplace@your-domain.com or ` +
          `"Your Marketplace <marketplace@your-domain.com>".`
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
    const recipient = maskRecipient(notification.to)

    // The caller supplies this (the subscriber passes the invite id), so a redelivered
    // event asks Resend to send the same message rather than a second copy. Resend
    // returns the original id for a repeated key instead of sending again.
    const idempotencyKey =
      typeof notification.data?.idempotency_key === "string"
        ? notification.data.idempotency_key
        : undefined

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const last = attempt === MAX_ATTEMPTS
      let response: Response

      try {
        response = await fetch(`${base}/emails`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.api_key}`,
            "Content-Type": "application/json",
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
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
        // A timeout or a dropped connection is exactly what a retry is for.
        const message = (error as Error).message
        if (!last) {
          await this.pause(attempt)
          continue
        }
        this.logger.error(
          `[resend] could not reach the API for "${notification.template}" to ${recipient} ` +
            `after ${attempt} attempts: ${message}`
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
        if (isRetryableStatus(response.status) && !last) {
          await this.pause(attempt, response.headers?.get?.("retry-after"))
          continue
        }

        const detail = await response.text().catch(() => "")
        this.logger.error(
          `[resend] rejected "${notification.template}" to ${recipient}: ` +
            `${response.status} ${detail}`
        )
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          `Resend rejected the email (${response.status}): ${detail}`
        )
      }

      const body = (await response.json().catch(() => ({}))) as { id?: string }

      this.logger.info(
        `[resend] sent "${notification.template}" to ${recipient} (id ${body.id})` +
          (attempt > 1 ? ` on attempt ${attempt}` : "")
      )

      return { id: body.id }
    }

    // Unreachable: the final attempt either returns or throws.
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Resend send did not complete")
  }

  /** Exponential backoff, unless Resend named a delay of its own. */
  private async pause(attempt: number, retryAfter?: string | null) {
    const base = this.options.retry_base_delay_ms ?? RETRY_BASE_DELAY_MS
    const seconds = retryAfter ? Number(retryAfter) : NaN
    const wait = Number.isFinite(seconds)
      ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
      : base * 2 ** (attempt - 1)

    await sleep(wait)
  }
}
