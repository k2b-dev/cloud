# ChoiceList

`ChoiceList` picks one value from a few choices that each need a sentence, such as how often something notifies you or who may see it. Each row shows a radio, a label, an optional quiet marker, and one sentence on what the choice means. The parent owns the value.

## Use ChoiceList

Use it when the person must understand the consequence of each choice before choosing, and there are only a handful of choices that should stay visible. Use `ChoiceChips` for quick picks without explanation, `RichSelect` when the list is longer and belongs in a dropdown, `ChoiceTiles` when a preview decides faster than words, and `Switch` for a single on or off.

## Import

```tsx
import { ChoiceList, type ChoiceListOption } from "@k2b/ui";
```

## Options, markers, and details

`options` contain `value`, `label`, an optional `description`, and an optional `marker`. The controlled `value` is one option's value or `null`, which selects no row.

- `description` is one sentence under the label. Keep it to what changes for the person.
- `marker` is a quiet tag after the label, such as "Default" on the choice that applies when the person has not chosen. It moves with the default, not with the selection.
- `details` are follow-up controls for the chosen row, such as a duration. They open directly under the chosen row, aligned with its text, and close when another row is chosen. Render them only when they belong to the current value.

Choosing changes only the row's fill and the radio, so nothing moves. See [shared field props](/en/ui/getting-started#shared-field-props) for labels, descriptions, errors, disabled state, and value accessors.

## Save while choosing

When a choice saves at once, set `busy` while the save runs and name it with `busyLabel`. A spinner appears beside the chosen row's label, in a place every row keeps, so the label never shifts. The rows stay usable. When the save fails, set the value back to the saved one and say what applies next to the list, with a way to try again.

## Runtime

Selection and focus movement require browser code. Without it the rows render with their checked state, markers, and descriptions.

## Example

```tsx
const [level, setLevel] = createSignal<string | null>("all");

<ChoiceList
  label="Notifications"
  value={level}
  onValueChange={setLevel}
  options={[
    { value: "all", label: "All messages", description: "Every new message notifies you.", marker: "Default" },
    { value: "mentions", label: "Mentions only", description: "Only when someone mentions you or replies to you." },
    { value: "off", label: "Off", description: "No notifications." },
  ]}
  details={level() === "off" ? <ChoiceChips aria-label="For how long" value={duration} onValueChange={setDuration} options={durations} /> : undefined}
/>
```

## API reference

```ts
type ChoiceListOption<T extends string = string> = { value: T; label: string; description?: string; marker?: string };

type ChoiceListProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly ChoiceListOption<T>[];
  busy?: boolean;
  busyLabel?: string;
  details?: JSX.Element;
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};
```

## Accessibility

The rows are a radio group named by `label`, or by `aria-label` without a visible label, and described by `description`. Each row's sentence describes its radio. Only the chosen row is in the tab order; with no selection the first row is. Arrow keys move and select with wrapping, Home and End select the first and last row. While `busy`, the group is marked busy and the spinner carries `busyLabel`. On touch screens every row is at least 44 px high.
