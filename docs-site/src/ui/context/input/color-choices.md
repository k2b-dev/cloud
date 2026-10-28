# ColorChoices

`ColorChoices` picks one colour from a fixed palette, shown as round swatches with names. The parent owns the palette and the value.

## Use ColorChoices

Use it when a person chooses from a few designed colours, such as a hair colour, a background, or a label colour. Use `ColorInput` when any colour is allowed.

## Import

```tsx
import { ColorChoices, type ColorChoiceOption } from "@k2b/ui";
```

## Options and state

`options` contain `value`, a `label` that names the colour, and `color`, any CSS colour. The controlled `value` is one option's value or `null`. The chosen swatch shows a check and a ring that sits outside the swatch without changing its size. Swatches are 2.25 rem, and 2.75 rem on touch screens (`pointer: coarse`).

See [shared field props](/en/ui/getting-started#shared-field-props) for labels, descriptions, errors, disabled state, and value accessors.

## Runtime

Selection and focus movement require browser code. Without it the swatches render with their checked state.

## Example

```tsx
const [background, setBackground] = createSignal<string | null>("sky");

<ColorChoices
  label="Background"
  value={background}
  onValueChange={setBackground}
  options={[
    { value: "sky", label: "Sky", color: "#d7e8fb" },
    { value: "mint", label: "Mint", color: "#d3efe1" },
    { value: "sand", label: "Sand", color: "#f5e6c6" },
  ]}
/>
```

## API reference

```ts
type ColorChoiceOption<T extends string = string> = { value: T; label: string; color: string };

type ColorChoicesProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly ColorChoiceOption<T>[];
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};
```

## Accessibility

The swatches are a radio group named by `label` or `aria-label`. Every swatch carries its colour name as accessible name and tooltip, so colour is never the only signal. Only the chosen swatch is in the tab order; arrow keys move and select with wrapping, Home and End select the first and last swatch.
