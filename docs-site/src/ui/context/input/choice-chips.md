# ChoiceChips

`ChoiceChips` picks one value from a handful of quick choices shown as a row of chips, such as a preset or a proposed date. The parent owns the value and what a choice changes.

## Use ChoiceChips

Use it when a few short, concrete choices should be one tap away inside a form, and when "nothing chosen yet" is a valid state.

Use `SegmentedControl` to switch between views or modes, `Select` for long or searchable lists, and `DatePicker` when any date is allowed. A chip row can sit next to such a field: pick a chip for the common case and the field for everything else.

## Import

```tsx
import { ChoiceChips, type ChoiceChipOption } from "@k2b/ui";
```

## Options and state

`options` contain `value`, `label`, and an optional Tabler `icon`. The controlled `value` is one option's value or `null`, which selects no chip. `onValueChange` and `onValueCommit` receive the chosen value; choosing never reports `null`.

The row never wraps. When the chips do not fit, it scrolls sideways and shows a thin scrollbar on hover or focus, so the row keeps one height on every screen and for every selection. On touch screens (`pointer: coarse`) chips are at least 44 px high.

See [shared field props](/en/ui/getting-started#shared-field-props) for labels, descriptions, errors, disabled state, and value accessors.

## API reference

```ts
type ChoiceChipOption<T extends string = string> = { value: T; label: string; icon?: string };

type ChoiceChipsProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly ChoiceChipOption<T>[];
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};
```

## Accessibility

The row is a radio group named by `label`, or by `aria-label` without a visible label, and described by `description`. Only the selected chip is in the tab order; with no selection the first chip is. Arrow keys move and select with wrapping, Home and End select the first and last chip, and a chosen chip scrolls into view. Icons never replace the chip label.

## Runtime

Selection and focus movement require hydrated Solid client code. Without it the chips render with their checked state.

## Example

```tsx
const [due, setDue] = createSignal<string | null>("2026-10-14");

<ChoiceChips
  label="Due"
  description="Proposed from the template · Wed or Thu · 17:00"
  value={due}
  onValueChange={setDue}
  options={[
    { value: "2026-10-14", label: "Wed 10/14" },
    { value: "2026-10-15", label: "Thu 10/15" },
    { value: "2026-10-21", label: "Wed 10/21" },
    { value: "other", label: "Other date…", icon: "ti ti-calendar" },
  ]}
/>;
```
