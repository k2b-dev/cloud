# NumberInput

`NumberInput` is an accessor-controlled numeric field with an explicit empty
state. The parent owns the number and decides when to persist it.

## Use NumberInput

Use it for counts, limits, percentages, currency amounts, and other numeric form values.

Use `TextInput` when the value is an identifier that only looks numeric, such as an account number or postal code.

## Import

```tsx
import { NumberInput } from "@k2b/ui";
```

## Value and events

Pass `value` directly or as an accessor returning `number | null`. `null` and
an omitted value render as empty; callbacks emit `null` when the field is
cleared.

`onValueChange` receives the parsed value while the user types.
`onValueCommit` receives the normalized value after blur, a stepper click, or
the default clear action.

The component keeps the raw text while focused, so intermediate input is not lost. A trailing decimal separator survives only when `decimalPlaces` is greater than `0`; at the default `0` a typed `12.` is normalized to `12`.

## Numeric rules

- `decimalPlaces` defaults to `0`. Set it explicitly for decimal values.
- A comma is normalized to a decimal point.
- `allowNegative` defaults to `true`.
- `min` and `max` clamp committed values.
- `step` defaults to `1` and snaps committed values to its grid.
- The default stepper buttons are integrated into the left and right edges of the input.
- `showSteppers={false}` hides the buttons without disabling typed input.
- `disableSteppers` disables only the buttons.
- The placeholder and numeric value are both right-aligned; the placeholder is visually quieter than entered values.

`prefix` and `suffix` display short units inside the field. `clearable` adds an explicit empty-state action.

## Accessibility

Prefer a visible `label`. Without one, the placeholder becomes the accessible name, with **Enter number** as the final fallback.

The input exposes spinbutton semantics and finite minimum, maximum, and current values. The stepper and clear controls have accessible names. Descriptions and reactive errors are connected to the field.

## Runtime

The field renders in server HTML. Input filtering, raw-text preservation, steppers, clearing, and callbacks require hydrated Solid client code.

## Example

```tsx
const [price, setPrice] = createSignal<number | null>(12.5);

<NumberInput
  label="Price"
  value={price}
  onValueChange={setPrice}
  min={0}
  step={0.01}
  decimalPlaces={2}
  suffix="€"
  clearable
  showSteppers={false}
/>;
```
