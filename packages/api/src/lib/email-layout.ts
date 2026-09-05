/**
 * Shared rendering for the transactional emails this project sends.
 *
 * The seller invitation deliberately does NOT use this: its markup mirrors Mercur's own
 * `sendSellerInvitationEmailStep` so the two look identical should a future release start
 * calling that step instead of our subscriber. It is also the one email path proven
 * end-to-end against live Resend, so it is left alone. Everything written since shares
 * this layout instead of copying that markup a third time.
 */

/**
 * Anything interpolated into markup has to be escaped. None of what these emails
 * interpolate is trusted: addresses come from whatever was typed into a form, store and
 * product names come from sellers, and URL origins come from environment variables.
 * Unescaped, a `<` or a quote breaks out of its context and injects markup into the
 * outgoing email. Ampersand first, or the escapes escape each other.
 */
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * "11 September 2026", or undefined if the value is missing or unparseable. UTC on
 * purpose: the recipient's timezone is unknown, and a date that silently shifts by a day
 * is worse than one that is explicit about the day it means.
 */
export function formatDate(value?: string | Date) {
  if (!value) {
    return undefined
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

/**
 * Money, from Medusa's minor-unit integers. `Intl` is given the currency so that the
 * symbol, its position and the number of decimals all follow the currency rather than
 * being guessed — JPY has no minor unit, and dividing it by 100 would be wrong.
 */
export function formatMoney(amount: number, currencyCode: string) {
  const code = currencyCode.toUpperCase()
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: code }).format(
      amount
    )
  } catch {
    // An unknown or malformed currency code must not cost the customer their receipt.
    return `${amount.toFixed(2)} ${code}`
  }
}

export type EmailSection = {
  heading: string
  /** Already-escaped markup. Callers escape their own values before interpolating. */
  bodyHtml: string
  cta?: { label: string; url: string }
  /** Small print under the call to action — an expiry, a caveat. Plain text. */
  note?: string
  /** Closing line above the rule. Plain text. */
  footer?: string
}

/**
 * The shell every email shares: centred card, system font stack, inline styles only.
 * Inline because email clients discard `<style>` blocks, and tables because several still
 * do not lay out divs reliably.
 */
export function renderEmail({ heading, bodyHtml, cta, note, footer }: EmailSection) {
  const ctaHtml = cta
    ? `<tr>
            <td style="padding: 24px 0 0;">
              <a href="${escapeHtml(cta.url)}" style="display:inline-block;background-color:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">${escapeHtml(cta.label)}</a>
            </td>
          </tr>`
    : ""

  const noteHtml = note
    ? `<tr><td style="font-size:13px;color:#71717a;padding-top:16px;">${escapeHtml(note)}</td></tr>`
    : ""

  const footerHtml = footer
    ? `<tr>
            <td style="font-size:12px;color:#a1a1aa;padding-top:32px;border-top:1px solid #e4e4e7;">
              ${escapeHtml(footer)}
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
              ${escapeHtml(heading)}
            </td>
          </tr>
          <tr>
            <td style="font-size:14px;color:#52525b;line-height:1.6;">
              ${bodyHtml}
            </td>
          </tr>
          ${ctaHtml}
          ${noteHtml}
          ${footerHtml}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
