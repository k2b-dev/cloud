# Boolean inputs

`@k2b/ui` provides `Switch`, `Checkbox`, and `CheckboxCard` for controlled
boolean values. The parent owns the value, validation, and persistence.

## Use boolean inputs

Use `Switch` for an immediate on/off setting.

Use `Checkbox` for a selection, acknowledgement, or form value. Use `CheckboxCard` when the choice needs an explanation, icon, or color marker.

## Import

```tsx
import {
  Checkbox,
  CheckboxCard,
  Switch,
} from "@k2b/ui";
```

## State and variants

All three components accept `value` directly or as a Solid accessor. Because a
native boolean choice is atomic, each change reports the next value through
both `onValueChange` and `onValueCommit`.

All three support the shared `label`, `description`, reactive `error`,
`required`, and `disabled` field state.

For partial bulk selections, pass `indeterminate` to `Checkbox` only. A checkbox without a visible
`label` or `description` renders as a compact control; give that form an
accessible name with `aria-label`.

`CheckboxCard` takes a text or JSX `label`. Add either `icon` or a valid three-
or six-digit hex `color` as supporting context. `variant="input"` uses the
denser input surface; the default is `"card"`.

All three inherit [ValueFieldProps<boolean>](/en/ui/getting-started#shared-field-props).
`Checkbox` and `Switch` also accept `name?: string`; Checkbox adds
`indeterminate?: boolean` (false). CheckboxCard adds `icon?: string`,
`color?: string` and `variant?: "input" | "card"` (card).

## Accessibility

Each component uses a native checkbox. Labels activate the control, focus remains visible, and checked state is available to assistive technology.

The label must state what the checked value means. Do not rely on position, color, or the switch shape to convey state.

## Runtime

State changes require hydrated Solid client code. The native inputs remain visible to assistive technology.

## Example

```tsx
const [notifications, setNotifications] = createSignal(true);
const [review, setReview] = createSignal(false);

<Switch
  label="Notifications"
  value={notifications}
  onValueChange={setNotifications}
/>;

<CheckboxCard
  label="Needs review"
  description="Require approval before publishing."
  icon="ti ti-eye-check"
  value={review}
  onValueChange={setReview}
/>;

<Checkbox
  aria-label="Select visible records"
  value={allSelected()}
  indeterminate={someSelected() && !allSelected()}
  onValueChange={setAllSelected}
/>;
```
