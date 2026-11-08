# Slider

`Slider` edits one bounded numeric value with a native range input. The parent owns the value, validation, and persistence.

## Use Slider

Use it when relative position within a range matters more than entering an exact number.

Use `NumberInput` when exact values are the primary task, and
[`ChoiceSlider`](/en/ui/input/choice-slider) for a few named stops instead of numbers.

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

`valuePlacement="label"` places the value and reset button beside the label,
above the full-width track. The default, `"control"`, keeps them beside the
track. Without a label, both placements use the track row. `showValue={false}`
hides only the value; an available reset button stays in the chosen row.
In the label row the reset comes before the value, so values line up with the
right edge whether the setting has changed or is at its default.

With `center`, the filled track starts at the range midpoint. Double-click resets to `defaultValue`, or to the midpoint for a centered slider and `min` otherwise.

## Default value and reset

Pass `defaultValue` when the setting has a value it starts from, such as `1` for brightness or `0` for rotation. While the value differs from it, the shown value takes the accent color and a reset button appears in the chosen row. The button names the value it returns to, formatted by `formatValue`, such as "Reset to 100%". The button keeps its slot at the default too, invisible and out of the tab order, so changing the value moves nothing. Reset reports through both callbacks and returns focus to the slider. Without `defaultValue` there is no reset button and no changed color.

`disabled` mutes the label, displayed value, thumb and filled track in both
placements. A changed value stays muted until the slider is enabled again;
the reset button is disabled too. The layout keeps the same dimensions.

See [shared field props](/en/ui/getting-started#shared-field-props) for labels, errors, disabled state and value accessors.

## Accessibility

Always provide `label`; the displayed value alone does not name the native range input. Use `description` for units or consequences that are not clear from the label.

Browser keyboard controls remain available because the component uses `<input type="range">`.

## Runtime

Value updates and double-click reset require browser code.

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

For a compact settings panel, keep the value and reset in the label row:

```tsx
<Slider
  label="Contrast"
  value={contrast}
  onValueChange={setContrast}
  min={-100}
  max={100}
  center
  defaultValue={0}
  valuePlacement="label"
/>
```

Both layouts reserve the reset slot at the default value, so changing and
resetting the setting keeps the label and track in place.
