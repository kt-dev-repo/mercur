import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, ProductEvents } from "@medusajs/framework/utils"
import {
  OfferWorkflowEvents,
  ProductWorkflowEvents,
} from "@mercurjs/core/workflows"

type EventPayload = {
  id?: string
  product_id?: string
}

const resolveHandle = async (
  container: SubscriberArgs["container"],
  entity: "product" | "product_category" | "product_collection",
  id?: string
): Promise<string | undefined> => {
  if (!id) {
    return undefined
  }

  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity,
      fields: ["handle"],
      filters: { id },
    })
    return data?.[0]?.handle
  } catch {
    // A deleted entity cannot be read back. The base tag is still sent, which is what
    // actually matters for a deletion — the listing has to drop it.
    return undefined
  }
}

/**
 * The tag names are a contract with the storefront, which declares the identical set in
 * `src/lib/data/cache-tags.ts`. They must agree exactly: the storefront caches this data
 * with `revalidate: false`, so a `revalidateTag` is the ONLY thing that will ever drop it.
 * A tag it does not cache under is a no-op, and a tag it caches under that nothing here
 * sends means that data is cached permanently — which is what happened to categories and
 * collections until they were added below.
 */
const buildTags = async (
  container: SubscriberArgs["container"],
  eventName: string,
  payload: EventPayload
): Promise<string[]> => {
  const tags = new Set<string>()

  if (eventName.startsWith("product.product-category.")) {
    tags.add("categories")
    const handle = await resolveHandle(container, "product_category", payload.id)
    if (handle) {
      tags.add(`category-${handle}`)
    }
    return [...tags]
  }

  if (eventName.startsWith("product.product-collection.")) {
    tags.add("collections")
    const handle = await resolveHandle(container, "product_collection", payload.id)
    if (handle) {
      tags.add(`collection-${handle}`)
    }
    return [...tags]
  }

  // Product and offer events. An offer carries the product it is for, so both reach the
  // product's own page as well as the catalogue listing.
  tags.add("products")

  const isOffer = eventName.startsWith("offer.")
  const productId = isOffer ? payload.product_id : payload.id

  const handle = await resolveHandle(container, "product", productId)
  if (handle) {
    tags.add(`product-${handle}`)
  }

  if (isOffer) {
    tags.add("offers")
    if (payload.id) {
      tags.add(`offer-${payload.id}`)
    }
    if (productId) {
      tags.add(`product-offers-${productId}`)
    }
  }

  return [...tags]
}

export default async function storefrontCacheRevalidateHandler({
  event,
  container,
}: SubscriberArgs<EventPayload | EventPayload[]>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const url = process.env.STOREFRONT_REVALIDATE_URL
  const secret = process.env.STOREFRONT_REVALIDATE_SECRET

  if (!url || !secret) {
    return
  }

  const payloads = Array.isArray(event.data) ? event.data : [event.data]

  const tagSet = new Set<string>()
  for (const payload of payloads) {
    const tags = await buildTags(container, event.name, payload ?? {})
    tags.forEach((tag) => tagSet.add(tag))
  }

  // Without a deadline a hung storefront pins this subscriber open for as long as
  // the platform's default socket timeout allows, on every product event.
  const REVALIDATE_TIMEOUT_MS = 5000

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-revalidate-secret": secret,
      },
      body: JSON.stringify({ tags: [...tagSet] }),
      signal: AbortSignal.timeout(REVALIDATE_TIMEOUT_MS),
    })

    // fetch only rejects on transport failure. A wrong secret (401) or a broken
    // storefront route (500) resolves normally, so without this check the cache
    // silently goes stale and nothing anywhere reports it.
    if (!response.ok) {
      logger.error(
        `[storefront-cache-revalidate] revalidation rejected: ${response.status} ${response.statusText}`
      )
    }
  } catch (error) {
    logger.error(
      `[storefront-cache-revalidate] revalidation failed: ${(error as Error).message}`
    )
  }
}

export const config: SubscriberConfig = {
  event: [
    OfferWorkflowEvents.CREATED,
    OfferWorkflowEvents.UPDATED,
    OfferWorkflowEvents.DELETED,
    ProductWorkflowEvents.PUBLISHED,
    ProductWorkflowEvents.REJECTED,
    "product.updated",
    // Categories and collections. The storefront caches both indefinitely under the tags
    // above, so without these a new category, a rename, or a deletion never reaches a
    // shopper — the page is cached forever with nothing able to invalidate it.
    ProductEvents.PRODUCT_CATEGORY_CREATED,
    ProductEvents.PRODUCT_CATEGORY_UPDATED,
    ProductEvents.PRODUCT_CATEGORY_DELETED,
    ProductEvents.PRODUCT_COLLECTION_CREATED,
    ProductEvents.PRODUCT_COLLECTION_UPDATED,
    ProductEvents.PRODUCT_COLLECTION_DELETED,
  ],
  context: {
    subscriberId: "storefront-cache-revalidate-handler",
  },
}
