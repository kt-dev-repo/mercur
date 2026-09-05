import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { getOrderGroupDetailWorkflow } from "@mercurjs/core/workflows"
import { escapeHtml, formatMoney, renderEmail } from "../lib/email-layout"

type OrderGroupCreated = { id: string }

type OrderItem = { title?: string; quantity?: number; total?: number }
type ChildOrder = {
  id: string
  display_id?: number
  total?: number
  currency_code?: string
  items?: OrderItem[]
  seller?: { name?: string } | null
}

/**
 * Sends the order confirmation email.
 *
 * Listens on `order_group.created`, not `order.placed`. A multi-seller checkout emits
 * `order.placed` once per seller, so subscribing there would send the shopper three
 * emails for one purchase and none of them would show the whole basket. The group is the
 * purchase as the shopper made it; the child orders are how the marketplace operates it.
 * Mercur's own documentation draws the same line.
 *
 * (Sellers still need telling about their slice, but that is a different email to a
 * different recipient and is not written yet.)
 */
export default async function sendOrderConfirmationEmailHandler({
  event,
  container,
}: SubscriberArgs<OrderGroupCreated>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const notificationService = container.resolve(Modules.NOTIFICATION)

  const orderGroupId = event.data?.id
  if (!orderGroupId) {
    logger.warn("[order-confirmation-email] event carried no order group id; nothing sent.")
    return
  }

  try {
    // The workflow expands the child orders whatever `fields` says, and does the status
    // aggregation the raw service method does not. `cart.email` is how a guest checkout's
    // recipient is known — there may be no customer record at all.
    const { result } = await getOrderGroupDetailWorkflow(container).run({
      input: {
        order_group_id: orderGroupId,
        fields: [
          "id",
          "display_id",
          "total",
          "currency_code",
          "cart.email",
          "orders.id",
          "orders.display_id",
          "orders.total",
          "orders.currency_code",
          "orders.items.title",
          "orders.items.quantity",
          "orders.items.total",
          "orders.seller.name",
        ],
      },
    })

    const group = result as {
      id: string
      display_id?: number
      total?: number
      currency_code?: string
      cart?: { email?: string } | null
      orders?: ChildOrder[]
    }

    const email = group?.cart?.email
    if (!email) {
      // Without a recipient there is nothing to do, and it is not an error worth
      // throwing: the order itself is fine.
      logger.warn(
        `[order-confirmation-email] order group ${orderGroupId} has no email address; nothing sent.`
      )
      return
    }

    const orders = group.orders ?? []
    const currency = group.currency_code ?? orders[0]?.currency_code ?? "usd"

    // One notification per group, keyed on the group id. A redelivered
    // `order_group.created` must not send the customer a second receipt.
    const idempotencyKey = `order-confirmation-${group.id}`

    // Persisted so a broken seller lookup is visible. `content` is not stored by the
    // notification module, so without this an email that silently fell back to
    // "Order #12" for every seller would leave every assertion green — the same soft
    // failure the seller invitation had before `seller_name` was asserted.
    const sellerNames = orders
      .map((order) => order.seller?.name)
      .filter((name): name is string => Boolean(name))

    await notificationService.createNotifications({
      to: email,
      channel: "email",
      template: "orderConfirmation",
      idempotency_key: idempotencyKey,
      data: {
        email,
        order_group_id: group.id,
        display_id: group.display_id,
        seller_count: orders.length,
        seller_names: sellerNames,
        idempotency_key: idempotencyKey,
      },
      content: {
        subject: group.display_id
          ? `Your order #${group.display_id} is confirmed`
          : "Your order is confirmed",
        html: buildOrderConfirmationHtml(group.display_id, orders, group.total, currency),
      },
    })

    logger.info(`[order-confirmation-email] confirmation sent for order group ${group.id}`)
  } catch (error) {
    // Not rethrown. The order is placed and paid; failing the handler would neither
    // un-place it nor get the email sent, and an unhandled rejection here would show up
    // as a checkout error in the logs for a checkout that actually succeeded.
    logger.error(
      `[order-confirmation-email] could not send confirmation for ${orderGroupId}: ` +
        `${(error as Error).message}. Is EMAIL_PROVIDER configured?`
    )
  }
}

/**
 * The receipt, grouped by seller.
 *
 * The grouping is the point: the shopper paid once, but the purchase will arrive as
 * several separate deliveries, each shipped and possibly refunded independently. A flat
 * list of items would set the wrong expectation about how it turns up.
 */
export function buildOrderConfirmationHtml(
  displayId: number | undefined,
  orders: ChildOrder[],
  total: number | undefined,
  currencyCode: string
) {
  const sections = orders
    .map((order) => {
      const sellerName = order.seller?.name
      const label = sellerName
        ? escapeHtml(sellerName)
        : order.display_id
          ? `Order #${order.display_id}`
          : "Your items"

      const rows = (order.items ?? [])
        .map((item) => {
          const title = escapeHtml(item.title ?? "Item")
          const quantity = item.quantity ?? 1
          const line =
            typeof item.total === "number"
              ? escapeHtml(formatMoney(item.total, order.currency_code ?? currencyCode))
              : ""
          return `<tr>
                <td style="padding:4px 0;font-size:14px;color:#52525b;">${title} &times; ${quantity}</td>
                <td style="padding:4px 0;font-size:14px;color:#52525b;text-align:right;">${line}</td>
              </tr>`
        })
        .join("")

      const orderTotal =
        typeof order.total === "number"
          ? `<tr>
                <td style="padding:8px 0 0;font-size:13px;color:#71717a;">Subtotal</td>
                <td style="padding:8px 0 0;font-size:13px;color:#71717a;text-align:right;">${escapeHtml(
                  formatMoney(order.total, order.currency_code ?? currencyCode)
                )}</td>
              </tr>`
          : ""

      return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
            <tr>
              <td colspan="2" style="font-size:13px;font-weight:600;color:#18181b;padding-bottom:4px;">
                Sold by ${label}
              </td>
            </tr>
            ${rows}
            ${orderTotal}
          </table>`
    })
    .join("")

  const totalHtml =
    typeof total === "number"
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px solid #e4e4e7;">
            <tr>
              <td style="padding-top:12px;font-size:15px;font-weight:600;color:#18181b;">Total</td>
              <td style="padding-top:12px;font-size:15px;font-weight:600;color:#18181b;text-align:right;">${escapeHtml(
                formatMoney(total, currencyCode)
              )}</td>
            </tr>
          </table>`
      : ""

  // Said plainly, because a shopper who ordered from three sellers and receives three
  // parcels on three days will otherwise think something went wrong.
  const splitNote =
    orders.length > 1
      ? `<p style="margin:16px 0 0;">Your order is being fulfilled by ${orders.length} sellers, so it will arrive in separate deliveries.</p>`
      : ""

  return renderEmail({
    heading: displayId ? `Your order #${displayId} is confirmed` : "Your order is confirmed",
    bodyHtml: `Thanks for your order — we've received it and the sellers have been notified.${splitNote}${sections}${totalHtml}`,
    footer: "If anything looks wrong, reply to this email and we'll sort it out.",
  })
}

export const config: SubscriberConfig = {
  event: "order_group.created",
  context: { subscriberId: "send-order-confirmation-email" },
}
