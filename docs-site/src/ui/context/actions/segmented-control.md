# SegmentedControl

`SegmentedControl` selects one value from a short, fixed set of mutually exclusive modes. The parent owns the current value and its effect on the view.

## Use SegmentedControl

Use it for a view or mode switch where every option can remain visible. The control fills its available width and gives every option equal space.

Use `Select` when the list is long, labels need more space, or the control represents an ordinary form field.

## Import

```tsx
import {
  SegmentedControl,
  type SegmentOption,
} from "@k2b/ui";
```

## Options and state

`SegmentedControl` is generic over a string union. `options` contain `value`, `label`, and an optional Tabler `icon`. The controlled `value` accessor must match one option, and `onValueChange` receives the selected value.

Use `disabled` for the whole group. Set an option's `disabled` property to skip it during keyboard navigation. `ariaLabel` names the group and defaults to `"Options"`.

Keep the option set short. Each option should describe the same dimension, such as List, Board, or Calendar.

The soft control has no tray, separators, or selection ring. The selected option takes the selection fill and ink; see [Colors and selection](/en/ui/surfaces/color). Font weight and geometry stay the same through selection and hover, so no option moves; keyboard focus keeps its visible ring. In forced-color mode the selected option is underlined.

## API reference

```ts
type SegmentOption<T extends string = string> = {
  value: T; label: JSX.Element; icon?: string; disabled?: boolean;
};

type SegmentedControlProps<T extends string = string> = {
  options: readonly SegmentOption<T>[]; value: T | (() => T); onValueChange: (value: T) => void;
  disabled?: boolean; ariaLabel?: string; label?: string; size?: "sm" | "md"; class?: string;
};
```

`size` defaults to `"md"`; `disabled` defaults to false. `ariaLabel` defaults to the localized Options label.

## Accessibility

The component renders a horizontal radio group. Only the selected option is in the tab order.

Arrow keys move and select with wrapping. Home and End select the first and last enabled options. Focus follows the new selection. Icons do not replace option labels.

## Runtime

Selection and focus movement require browser code.

## Example

```tsx
type View = "list" | "board" | "calendar";
const [view, setView] = createSignal<View>("board");

<SegmentedControl<View>
  ariaLabel="Workspace view"
  options={[
    { value: "list", label: "List", icon: "ti ti-list" },
    { value: "board", label: "Board", icon: "ti ti-layout-board" },
    {
      value: "calendar",
      label: "Calendar",
      icon: "ti ti-calendar",
    },
  ]}
  value={view}
  onValueChange={setView}
/>;
```
