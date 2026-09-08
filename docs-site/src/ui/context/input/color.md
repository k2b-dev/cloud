# ColorInput

`ColorInput` is a controlled wrapper around the browser color picker. The parent owns the color and any transparent state.

## Use ColorInput

Use it when a user chooses an arbitrary color.

Use predefined buttons, swatches, or `Select` when the product supports a fixed palette or named semantic colors.

## Import

```tsx
import { ColorInput } from "@k2b/ui";
```

## Value and display

Pass the color directly or through a Solid accessor. `onValueChange` receives
native picker input while `onValueCommit` receives the committed native change.
Without a value, the control displays `#3b82f6`.

With a label, the default full control shows the swatch and uppercase color value. Without a label, it defaults to a compact swatch. Set `compact` explicitly to override that choice.

## Transparent state

On the full control, `transparent` enables a transparent toggle. The parent
provides that state through `transparentValue` and updates it through
`onTransparentValueChange`. Compact mode renders only the color swatch.

Transparency is separate from the color value. Enabling it disables the native color picker but keeps the last color available for switching back.

## Accessibility

Prefer the full labeled control when the color has form meaning. Compact mode uses the string label as its accessible name and otherwise falls back to **Choose color**.

The transparent action exposes a pressed state and named switch-back action. Do not communicate a color's meaning through the swatch alone.

## Runtime

The swatch and current value render in server HTML. Opening the native picker, changing the value, and toggling transparency require hydrated Solid client code. The picker UI varies by browser and operating system.

## Example

```tsx
const [color, setColor] = createSignal("#06b6d4");
const [transparent, setTransparent] = createSignal(false);

<ColorInput
  label="Accent"
  value={color}
  onValueChange={setColor}
  transparent
  transparentValue={transparent}
  onTransparentValueChange={setTransparent}
/>;
```
