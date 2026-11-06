# ChoiceSlider

`ChoiceSlider` chooses one of a few named stops on a track. A fixed line above
the track always shows what the active stop means. The parent owns the value
and what each stop stands for.

## Use ChoiceSlider

Use it when the stops form an order that people compare by feel, such as
faster to more thorough, and each stop needs one short line that explains it.
Keep it to two to five stops.

Use `Slider` for a numeric range, `ChoiceChips` for unordered quick choices,
and `RichSelect` when each option needs more than one line or a preview.

## Import

```tsx
import { ChoiceSlider } from "@k2b/ui";
```

## Stops and the line

Each option has a `value`, a `label`, and an optional one-line `description`.
The line shows the description of the active stop and keeps its height
whatever it says, so moving the thumb or showing a reason moves nothing
around the slider.

An option with `disabledReason` stays visible as a hollow stop. Dragging and
the arrow keys skip it. A press on it, or an arrow key at its edge, shows the
reason in the line with a warning icon and leaves the value unchanged. When
the chosen value itself becomes unavailable, the thumb takes the warning
colour and the line shows the reason.

Pass `value={null}` when the current choice is none of the stops. The slider
then shows no thumb and the line shows `description`. The next drag or arrow
key chooses a stop again.

With one option the slider shows only the line; with none it shows an empty
line. Render your own empty state instead in that case.

## Values while dragging

`onValueChange` reports a stop when someone releases the thumb on it or moves
to it with the keyboard. `onActiveChange` reports the stop the slider shows
while someone drags, and `null` when it shows `value` again, so the
surrounding card can name the stop live.

## Size

`size="lg"` gives a 44 px track, a 28 px thumb, and larger stops for touch
sheets. The default fits popovers.

## Accessibility

The track is `role="slider"` with `aria-valuetext` from the label and the
description or reason; pass `valueText` on an option to say more, for example
the model behind a stop. Name it with `aria-label` or `aria-labelledby`.
Arrow keys, Page Up and Page Down move between available stops; Home and End
jump to the first and last available stop. Nothing depends on hovering. The
line is a polite live region.

## Runtime

Dragging and keyboard changes require browser code. Server rendering shows the
line, the stops, and the thumb at the current value.

## Example

```tsx
const [quality, setQuality] = createSignal<string | null>("standard");

<ChoiceSlider
  aria-label="Export quality"
  options={[
    { value: "draft", label: "Draft", description: "Quick and rough" },
    { value: "standard", label: "Standard", description: "For most documents" },
    { value: "print", label: "Print", disabledReason: "The printer is offline" },
  ]}
  value={quality}
  onValueChange={setQuality}
/>;
```
