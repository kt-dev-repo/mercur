---
name: admin-page-ui
description: Build a new page or section in the Admin or Vendor panel — file-based routes under src/routes, sidebar registration, list tables, detail sections, and data loading. Use when adding a screen, adding a section to an existing custom screen, wiring a DataTable, or deciding a page's layout and data-fetching shape.
---

# Panel page and section UI

A new screen in `apps/admin` or `apps/vendor` is one `page.tsx` file. The
`@mercurjs/dashboard-sdk` Vite plugin discovers it at build time from its path and wires
the route and the sidebar entry.

Read `medusa-ui-conformance` first — everything here assumes those rules.

Source of truth: `apps/admin/src/README.md`, `apps/vendor/src/README.md`, and
`node_modules/@mercurjs/docs/content/resources/best-practices/frontend.mdx`.

## File-based routing

Routes derive from the path relative to `src/routes/`. The file must be named `page.tsx`
(or `.ts`, `.jsx`, `.js`).

| File | Route |
|---|---|
| `src/routes/page.tsx` | `/` |
| `src/routes/blog/page.tsx` | `/blog` |
| `src/routes/blog/[id]/page.tsx` | `/blog/:id` |
| `src/routes/blog/[[id]]/page.tsx` | `/blog/:id?` |
| `src/routes/blog/[*]/page.tsx` | `/blog/*` |
| `src/routes/(group)/foo/page.tsx` | `/foo` |
| `src/routes/dashboard/@sidebar/page.tsx` | parallel route |

Note the panels are mounted by `packages/api/medusa-config.ts`: the admin panel at
`/dashboard` and the vendor panel at `/seller`. Route paths above are relative to that
mount — do not hardcode the mount prefix.

## Page exports

| Export | Required | Purpose |
|---|---|---|
| `default` | yes | the React component |
| `config` | no | sidebar entry (`RouteConfig`) |
| `loader` | no | React Router data loader |
| `handle` | no | route metadata, read via `useMatches()` |

```tsx
import { Container, Heading } from "@medusajs/ui"
import { Star } from "@medusajs/icons"
import type { RouteConfig } from "@mercurjs/dashboard-sdk"

export const config: RouteConfig = {
  label: "Reviews",   // required
  icon: Star,
  // rank        — sidebar ordering
  // nested      — parent menu path to nest under
  // translationNs — i18n namespace for the label
}

export default function ReviewsPage() {
  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading>Reviews</Heading>
      </div>
    </Container>
  )
}
```

## Layout

Pick one, both from `@mercurjs/dashboard-shared`:

- `SingleColumnPage` — lists and simple screens
- `TwoColumnPage` — a detail screen with a sidebar; children go under
  `TwoColumnPage.Main` and `TwoColumnPage.Sidebar`, stacked with `gap-y-3`

## List table

Build columns with `createColumnHelper` from `@tanstack/react-table`, wire with
`useDataTable`, page size 20.

```tsx
import { SingleColumnPage, DataTable, useDataTable, ActionMenu } from "@mercurjs/dashboard-shared"
import { Container, Heading } from "@medusajs/ui"
import { createColumnHelper } from "@tanstack/react-table"

const columnHelper = createColumnHelper<Review>()

const columns = [
  columnHelper.accessor("title", { header: "Title" }),
  columnHelper.accessor("rating", { header: "Rating" }),
  columnHelper.display({
    id: "actions",
    cell: ({ row }) => (
      <ActionMenu groups={[{ actions: [{ label: "Edit", to: `${row.original.id}/edit` }] }]} />
    ),
  }),
]

export default function ReviewsPage() {
  const { reviews = [], count = 0, isLoading } = useReviews()
  const { table } = useDataTable({
    data: reviews,
    columns,
    count,
    pageSize: 20,
    getRowId: (r) => r.id,
  })

  return (
    <SingleColumnPage>
      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <Heading>Reviews</Heading>
        </div>
        <DataTable
          table={table}
          columns={columns}
          count={count}
          pageSize={20}
          isLoading={isLoading}
          navigateTo={(row) => row.id}
          pagination
          search
        />
      </Container>
    </SingleColumnPage>
  )
}
```

## Detail section

A "general" section is the `Container` header row plus `SectionRow` pairs:

```tsx
<Container className="divide-y p-0">
  <div className="flex items-center justify-between px-6 py-4">
    <Heading>{review.title}</Heading>
    <ActionMenu groups={[{ actions: [{ label: "Edit", to: "edit" }] }]} />
  </div>
  <SectionRow title="Rating" value={`${review.rating} / 5`} />
  <SectionRow title="Status" value={review.approved ? "Approved" : "Pending"} />
</Container>
```

## Data

All HTTP goes through the typed client in a TanStack Query hook. **No raw `fetch` in a
page.** In this repository the client is exported as `client` from `src/lib/client.ts`
(the upstream docs name it `sdk`). Route types come from `@acme/api/_generated`, which
requires `bun run codegen` to have run.

```ts
// src/hooks/api/reviews.ts
import { useQuery } from "@tanstack/react-query"
import { queryKeysFactory } from "@mercurjs/dashboard-shared"
import { client } from "../../lib/client"

const reviewKeys = queryKeysFactory("reviews")

export const useReviews = (query?: Record<string, unknown>) =>
  useQuery({
    queryKey: reviewKeys.list(query),
    queryFn: () => client.vendor.reviews.query({ ...query }),
  })
```

Mutations invalidate `lists()`, `details()`, and `detail(id)`. Throw on `isError` so the
route `ErrorBoundary` catches it. Render a `Skeleton` while loading.

## Extending a built-in page instead

Do **not** copy a built-in page to change it. Pick the smallest surface:

- add a component at a named zone → a widget in `src/widgets/*.tsx` (`defineWidgetConfig`)
- add a field, column, or read-only row to a built-in model → `src/custom-fields/<model>.tsx`
  (see `admin-form-ui`)
- reorder/hide/relabel sidebar items → `src/_navigation.ts` (`defineNavigationConfig`)

## Verify

- The route resolves at its derived path, and the sidebar entry appears when `config` is exported.
- `bun run check-types` passes — a bad `zone`, `model`, or nav `id` fails type-check against
  the generated registry in `src/extension-targets.d.ts`.
- `bun run lint` passes.
- Loading, empty, error and success states all render.

## Related

- `medusa-ui-conformance` — the design-system rules this page assumes
- `admin-form-ui` — forms and validated fields
- `admin-tab-ui` — multi-step and tabbed forms
