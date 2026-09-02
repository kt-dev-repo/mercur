---
name: medusa-ui-conformance
description: Enforce the Admin/Vendor panel design system when writing any custom UI in apps/admin or apps/vendor — components, sections, reusable interaction patterns, or new primitives. Use before introducing a component, a layout, a colour, or a dependency. Covers the allowed packages (@medusajs/ui, @medusajs/icons, @mercurjs/dashboard-shared), the UI token rules, the section shell, and the import paths that survive an upgrade.
---

# Medusa UI conformance

The Admin and Vendor panels share one design system. Custom UI that ignores it looks
wrong immediately and breaks on the next `@medusajs/ui` bump. This skill is the
conformance checklist.

Source of truth (offline, version-matched to the installed packages):
`node_modules/@mercurjs/docs/content/resources/best-practices/frontend.mdx`

## The three allowed sources

| What | Package |
|---|---|
| Components | `@medusajs/ui` |
| Icons | `@medusajs/icons` |
| Page/table/modal/form primitives | `@mercurjs/dashboard-shared` |

```tsx
import { Container, Heading, Text, Button, Badge, StatusBadge, Input, toast } from "@medusajs/ui"
import { PencilSquare, Trash, EllipsisHorizontal } from "@medusajs/icons"
import { SingleColumnPage, DataTable, SectionRow, ActionMenu } from "@mercurjs/dashboard-shared"
```

## Hard rules

1. **Never introduce a second UI library.** No MUI, no shadcn, no Radix directly, no
   Tailwind component kit. Build on the existing primitives.
2. **Never restyle a Medusa UI component with custom CSS.** If a primitive does not do
   what you need, compose it — do not override it.
3. **Colour, spacing and type come from Medusa UI tokens only.** Use `text-ui-fg-*`,
   `bg-ui-bg-*`, `border-ui-border-*`. Never a hex value, `rgb()`, or a raw Tailwind
   palette class like `text-gray-500`.
4. **Import shared primitives from `@mercurjs/dashboard-shared`**, never from a
   Medusa-internal relative path such as `../../../components/table/data-table`.
   Internal paths are not part of the public surface and break on upgrade.
5. **Every visible string is translated**, and **every interactive element carries a
   `data-testid`**.

## The section shell

A section is a `Container` with a divided card and a header row. This is the shape every
built-in page uses; match it so custom sections sit flush with built-in ones.

```tsx
<Container className="divide-y p-0">
  <div className="flex items-center justify-between px-6 py-4">
    <Heading level="h2">Details</Heading>
    <Button size="small" variant="secondary" data-testid="edit-details">
      Edit
    </Button>
  </div>
  <div className="px-6 py-4">
    <Text size="small" className="text-ui-fg-subtle">
      Body
    </Text>
  </div>
</Container>
```

For read-only label/value rows inside that shell, use `SectionRow` rather than hand-rolling
a two-column grid:

```tsx
<SectionRow title="Rating" value={`${review.rating} / 5`} />
```

Stack sections with `gap-y-3`. In a two-column detail layout, place them under
`TwoColumnPage.Main` and `TwoColumnPage.Sidebar`.

## Before you write a new component

Work through this in order and stop at the first hit:

1. Does `@mercurjs/dashboard-shared` already export it? It exports 200+ primitives —
   check first. `grep "declare const " node_modules/@mercurjs/dashboard-shared/dist/index.d.ts`
2. Does `@medusajs/ui` have it?
3. Can you compose it from the two above?
4. Only then write something new — and build it from `@medusajs/ui` primitives and tokens.

## Status and state

Surface entity state with `StatusBadge`, and keep the state change going through the typed
client and a workflow hook — never a direct write from the component.

```tsx
<StatusBadge color={data.approved ? "green" : "orange"}>
  {data.approved ? "Approved" : "Pending"}
</StatusBadge>
```

Preserve the four states on every screen you touch: **loading** (`Skeleton`), **empty**,
**error** (throw so the route `ErrorBoundary` catches it), and **success**.

## Data access

Never call `fetch` from a component. All HTTP goes through the typed client wrapped in a
TanStack Query hook. In this repository the client is exported as `client` from
`src/lib/client.ts` in each app (the upstream docs call it `sdk`):

```ts
import { client } from "../../lib/client"
```

## Verify

- `bun run lint` and `bun run check-types` pass in the app you touched.
- No hex, `rgb()`, or raw palette class in the diff:
  `grep -nE "#[0-9a-fA-F]{3,6}|rgb\(|text-(gray|slate|zinc)-" <changed files>`
- No Medusa-internal relative import in the diff:
  `grep -n "components/table\|components/common" <changed files>`
- No new UI dependency in `apps/*/package.json`.

## Related

- `admin-page-ui` — composing a whole page or section
- `admin-form-ui` — form fields and validation
- `admin-tab-ui` — tabbed and wizard forms
