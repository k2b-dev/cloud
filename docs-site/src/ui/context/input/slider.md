# Slider

`Slider` edits one bounded numeric value with a native range input. The parent owns the value, validation, and persistence.

## Use Slider

Use it when relative position within a range matters more than entering an exact number.

Use `NumberInput` when exact values are the primary task.

## Import

```tsx
import { Slider } from "@k2b/ui";
```

## Range and display

Pass the required number directly or through a Solid accessor.
`onValueChange` receives each value while the range input moves;
`onValueCommit` receives the native committed change. Double-click reset
reports through both callbacks.

`min`, `max`, and `step` default to `0`, `100`, and `1`. `showValue` defaults
to `true`; `formatValue` controls its text.

With `center`, the filled track starts at the range midpoint. Double-click resets to `defaultValue`, or to the midpoint for a centered slider and `min` otherwise.

See [shared field props](/en/ui/getting-started#shared-field-props) for labels, errors, disabled state and value accessors.

## Accessibility

Always provide `label`; the displayed value alone does not name the native range input. Use `description` for units or consequences that are not clear from the label.

Browser keyboard controls remain available because the component uses `<input type="range">`.

## Runtime

Value updates and double-click reset require hydrated Solid client code.

## Example

```tsx
const [volume, setVolume] = createSignal(64);

<Slider
  label="Volume"
  value={volume}
  onValueChange={setVolume}
  min={0}
  max={100}
  formatValue={(value) => `${value}%`}
/>;
```
