# IconChoices

`IconChoices` picks one icon from a few named icons, shown as a row of icon buttons. The parent owns the icons and the value.

## Use IconChoices

Use it when a person marks something with one of a few fitting icons, such as a template that shows in a menu. Use `IconInput` when any icon of the catalogue is allowed.

## Import

```tsx
import { IconChoices, type IconChoiceOption } from "@k2b/ui";
```

## Options and state

`options` contain `value`, a `label` that names the icon, and `icon`, an icon class such as `ti ti-report`. The controlled `value` is one option's value or `null`. The chosen icon takes the selection tint without changing its size. Buttons are 2 rem, and 2.75 rem on touch screens (`pointer: coarse`). Each button carries its label as its name and tooltip, so the picture is never the only signal. Arrow keys move between the icons as in any radio group.

See [shared field props](/en/ui/getting-started#shared-field-props) for labels, descriptions, errors, disabled state, and value accessors.

## Runtime

Selection and focus movement require browser code. Without it the icons render with their checked state.

## Example

```tsx
const [icon, setIcon] = createSignal<string | null>("ti ti-report");

<IconChoices
  label="Icon"
  value={icon}
  onValueChange={setIcon}
  options={[
    { value: "ti ti-report", label: "Report", icon: "ti ti-report" },
    { value: "ti ti-package", label: "Package", icon: "ti ti-package" },
    { value: "ti ti-truck", label: "Truck", icon: "ti ti-truck" },
  ]}
/>
```

## API reference

```ts
type IconChoiceOption<T extends string = string> = { value: T; label: string; icon: string };

type IconChoicesProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly IconChoiceOption<T>[];
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};
```
