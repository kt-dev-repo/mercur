---
name: admin-form-ui
description: Build or extend forms in the Admin and Vendor panels — validated custom fields on built-in models, edit drawers, and submission flow. Use when adding a field to a built-in create/edit form, writing a new form screen, wiring Zod validation, or persisting values through additional_data.
---

# Panel form UI

Two distinct jobs, two different surfaces. Pick the right one first.

| Goal | Surface |
|---|---|
| Add a field to a **built-in** model's form (product, order, customer) | `src/custom-fields/<model>.tsx` |
| A **new** form on your own screen | `RouteDrawer` + `Form` on a `page.tsx` |

Read `medusa-ui-conformance` first.

Source of truth:
`node_modules/@mercurjs/docs/content/resources/tutorials/extend-forms-and-tables.mdx`
and `.../best-practices/frontend.mdx`.

## Extending a built-in form

One file per model, default-exporting `defineCustomFieldsConfig`. The two imports live in
**different packages** and must not be crossed over:

```tsx
import { defineCustomFieldsConfig } from "@mercurjs/dashboard-sdk"   // build-time config, zod-free
import { createFormHelper } from "@mercurjs/dashboard-shared"        // runtime form surface (zod)
```

```tsx
// apps/vendor/src/custom-fields/product.tsx
import { defineCustomFieldsConfig } from "@mercurjs/dashboard-sdk"
import { createFormHelper } from "@mercurjs/dashboard-shared"

type ProductWithMeta = { metadata?: Record<string, unknown> }
const form = createFormHelper<ProductWithMeta>()

export default defineCustomFieldsConfig({
  model: "product",
  forms: [
    {
      zone: "edit",
      fields: {
        erp_id: form.define({
          validation: form.string().optional(),
          label: "ERP ID",
          description: "External system identifier",
          placeholder: "ERP-000",
          defaultValue: (data) => (data?.metadata?.erp_id as string) ?? "",
        }),
      },
    },
  ],
})
```

### The `createFormHelper` surface

```ts
const form = createFormHelper<T>()

form.define({
  validation: form.string().min(1),  // string | number | boolean | date | array | object | null | nullable | coerce
  label: "…",
  description: "…",
  placeholder: "…",
  defaultValue: "" | ((data) => /* derive from the entity */),
  component,                          // optional custom render
})
```

Fields render through the standard `Form.Field → Form.Item` chain — **never a raw
`Controller`** — and join the existing `TabbedForm` / `RouteDrawer` submit and validation
flow automatically.

### Where the value goes

`defineCustomFieldsConfig` is a **panel surface, not a schema**. It renders and validates;
it creates no database column. Panel custom fields submit under `additional_data` and, for
`product`, land on `product.metadata`. For durable, queryable storage use the backend
Custom Fields module or your own route/workflow — and route the write through a workflow
hook, never a direct write from the component.

### Read-only rows and list columns

The same file owns detail-section displays and list-table columns:

```tsx
displays: [
  {
    zone: "general",
    fields: [
      { id: "erp_id", component: ({ data }) => <Text size="small" className="text-ui-fg-subtle px-6 py-4">{String(data?.metadata?.erp_id ?? "-")}</Text> },
      { id: "subtitle", component: null },     // hide a built-in field
      { id: "handle", component: MyHandle },   // replace a built-in field
    ],
  },
],
list: {
  columns: [{ id: "erp_id", header: "ERP", component: ({ row }) => String(row.metadata?.erp_id ?? "-") }],
  viewDefaults: {
    columnVisibility: { collection: false },
    columnOrder: ["product", "erp_id", "status"],
  },
},
```

An unknown `id` adds a row; a built-in `id` replaces one; `component: null` hides one.

To read a linked module's data alongside the entity, declare `link: "brand"` (or an array).
The SDK derives the query — never hand-write the field list.

### Find the valid models and zones

The registry, not the prose docs, is authoritative — the bundled docs are older than the
package and understate what is mounted. Each panel generates its own:

```bash
grep -n "formZones\|displayZones\|formTabs" node_modules/@mercurjs/admin/dist/extension-targets.d.ts
grep -n "formZones\|displayZones\|formTabs" node_modules/@mercurjs/vendor/dist/extension-targets.d.ts
```

`src/extension-targets.d.ts` already references these for the whole app, so `model`, `zone`,
`tab` and built-in field ids autocomplete and a typo fails `check-types`. Keep that file.

## A new form on your own screen

Quick edits live in a routed `RouteDrawer` with `Form` (React Hook Form + Zod). Gate the
form until the entity has loaded, and close with `useRouteModal().handleSuccess()`.

```tsx
// apps/vendor/src/routes/reviews/[id]/edit/page.tsx
import { RouteDrawer, useRouteModal, Form, KeyboundForm } from "@mercurjs/dashboard-shared"
import { Heading, Button, Input, toast } from "@medusajs/ui"

export default function EditReviewPage() {
  return (
    <RouteDrawer>
      <RouteDrawer.Header>
        <RouteDrawer.Title asChild>
          <Heading>Edit review</Heading>
        </RouteDrawer.Title>
      </RouteDrawer.Header>
      {/* render the form only once !isPending && !!review */}
    </RouteDrawer>
  )
}
```

`RouteDrawer` exposes `Header`, `Title`, `Body`, `Description`, `Footer`, `Close`, and
`Form`. Use `RouteDrawer.Form` with `KeyboundForm` so keyboard submit works, and
`useRouteModal().handleSuccess()` on save.

## Rules

1. Validation is Zod, declared through `form.define({ validation })` or a schema passed to
   the resolver — never ad-hoc `if` checks in the submit handler.
2. Never a raw `Controller`; always `Form.Field → Form.Item`.
3. Never a direct write. Mutations go through the typed `client` and ride `additional_data`
   into a workflow hook.
4. Every label, description, placeholder and error is translated.
5. Every input and button carries a `data-testid`.
6. Preserve loading, error, empty and success states; `toast.success` / `toast.error` on
   the outcome.

## Verify

- The field renders in the target form, validates on submit, and the value survives a reload.
- `npm run check-types` fails on a bad `model`, `zone`, or field `id` — that type-check
  against the generated registry is the real test. Try `zone: "nope"` and confirm it fails.
- `npm run lint` passes.

## Related

- `medusa-ui-conformance` — design-system rules
- `admin-page-ui` — the page the form sits on
- `admin-tab-ui` — multi-step and tabbed forms
