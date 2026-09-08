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

Dividers appear only between adjacent inactive options. Selecting an option removes the dividers next to that option so its active surface remains visually continuous.

## Accessibility

The component renders a horizontal radio group. Only the selected option is in the tab order.

Arrow keys move and select with wrapping. Home and End select the first and last enabled options. Focus follows the new selection. Icons do not replace option labels.

## Runtime

Selection and focus movement require hydrated Solid client code.

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
