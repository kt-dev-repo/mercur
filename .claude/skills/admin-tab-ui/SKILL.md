---
name: admin-tab-ui
description: Build tabbed and multi-step (wizard) forms in the Admin and Vendor panels with TabbedForm from @mercurjs/dashboard-shared — tab definitions, per-tab validation gating, next/submit footer, and the vendor onboarding zone. Use for any form split across steps or tabs.
---

# Tabbed and wizard forms

A form split across steps uses `TabbedForm` from `@mercurjs/dashboard-shared`. It owns tab
state, per-tab validation gating, and the next/submit transition, so do not hand-roll a
step index with `useState`.

Read `admin-form-ui` first — field definition and validation rules come from there.

## The verified API

From `node_modules/@mercurjs/dashboard-shared/dist/index.d.ts`:

```ts
type TabbedFormProps<T extends FieldValues> = {
  form: UseFormReturn<T>
  onSubmit: (e?: React.BaseSyntheticEvent) => void
  children: ReactNode
  isLoading?: boolean
  footer?: (props: FooterRenderProps) => ReactNode
  transformTabs?: (tabs: TabDefinition<T>[]) => TabDefinition<T>[]
  model?: string
  zone?: string
}

type FooterRenderProps = {
  isLastTab: boolean
  onNext: () => void
  isLoading?: boolean
}

TabbedForm.Tab: (props: { id: string; label: string; children?: ReactNode }) => JSX.Element
TabbedForm.useForm: <T>() => UseFormReturn<T>
```

Also exported: `useTabbedForm()` and `useTabManagement({ tabs, form })`, which returns
`activeTabId`, `setActiveTabId`, `tabState`, `visibleTabs`, `isLastTab`, `onNext`, and
`onTabChange`. Reach for `useTabManagement` only when you are building a custom shell —
`TabbedForm` already uses it.

## Shape

```tsx
import { TabbedForm } from "@mercurjs/dashboard-shared"
import { Button } from "@medusajs/ui"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"

const schema = z.object({
  name: z.string().min(1),
  address_1: z.string().min(1),
})

export default function StoreSetupForm() {
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", address_1: "" },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    // mutate through the typed client, then useRouteModal().handleSuccess()
  })

  return (
    <TabbedForm
      form={form}
      onSubmit={onSubmit}
      isLoading={form.formState.isSubmitting}
      footer={({ isLastTab, onNext, isLoading }) => (
        <Button
          type={isLastTab ? "submit" : "button"}
          onClick={isLastTab ? undefined : onNext}
          isLoading={isLoading}
          data-testid={isLastTab ? "submit-form" : "next-tab"}
        >
          {isLastTab ? "Save" : "Continue"}
        </Button>
      )}
    >
      <TabbedForm.Tab id="details" label="Details">
        {/* Form.Field → Form.Item for each field */}
      </TabbedForm.Tab>
      <TabbedForm.Tab id="address" label="Address">
        {/* … */}
      </TabbedForm.Tab>
    </TabbedForm>
  )
}
```

Inside a deeply nested tab child, reach the form with `TabbedForm.useForm<T>()` rather than
threading `form` down through props.

## Rules

1. **Never hand-roll step state.** No `useState(step)`, no manual `if (step === 2)`.
   `TabbedForm` owns tab state and gating.
2. **`id` is stable and meaningful** — it is what validation gating, `transformTabs`, and
   the onboarding `tab` key match on. Do not use an array index.
3. **Validate per tab.** `onNext` advances only when the current tab's fields pass, so put
   every field in the schema and let the resolver gate the step. Do not validate everything
   only at the end.
4. **One `onSubmit` for the whole form**, fired on the last tab. Intermediate tabs never
   submit.
5. **The footer is a render prop.** Derive the button from `isLastTab`; do not render two
   competing buttons or duplicate the submit control inside a tab.
6. Every tab `label` is translated; every control carries a `data-testid`.

## Extending a built-in tabbed form

`TabbedForm` accepts `model` and `zone`, which is how a built-in multi-step form picks up
contributed fields. From your side you contribute through
`defineCustomFieldsConfig` (see `admin-form-ui`) — you do not re-declare the host form.

Use `transformTabs` only to reorder or filter tabs on a form you own.

## The vendor onboarding wizard

The onboarding surface is the same custom-fields helper with `zone: "onboarding"` and `tab`
set to a wizard step id. It is **vendor-only** (`apps/vendor`), and it hangs off the
`seller` model, not `product`:

```ts
// node_modules/@mercurjs/vendor/dist/extension-targets.d.ts
"seller": {
  formZones: "address" | "edit" | "onboarding" | "payment-details" | "professional-details"
  formTabs: Record<string, string>
  displayZones: "general" | "seller-select"
}
```

`formTabs` is the `tab` key — the wizard step id you target alongside the zone.

```tsx
// apps/vendor/src/custom-fields/seller.tsx
export default defineCustomFieldsConfig({
  model: "seller",
  forms: [
    {
      zone: "onboarding",
      tab: "professional-details",
      fields: { vat_number: form.define({ validation: form.string().optional(), label: "VAT number" }) },
    },
  ],
})
```

The bundled docs describe this zone as "designed but not mounted in the MVP". That text is
older than the installed package — the zone is registered in `@mercurjs/vendor` 2.3.3, so
type-check will accept it. Whether it *renders* still depends on your version, so confirm
before building on it:

```bash
grep -n "onboarding" node_modules/@mercurjs/vendor/dist/extension-targets.d.ts
```

If the zone does not render for you, build the step as a normal `TabbedForm` on your own
route instead of contributing to a zone that will not mount.

## Verify

- Each tab gates: leave a required field empty and confirm `onNext` refuses to advance.
- Only the last tab submits.
- `bun run check-types` and `bun run lint` pass in the app you touched.
- Tab labels are translated and every control has a `data-testid`.

## Related

- `admin-form-ui` — field definition, validation, `additional_data`
- `admin-page-ui` — the route the form is mounted on
- `medusa-ui-conformance` — design-system rules
