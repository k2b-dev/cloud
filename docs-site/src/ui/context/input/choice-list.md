# ChoiceList

`ChoiceList` picks one value from a few choices that each need a sentence, such as how often something notifies you or who may see it. Each choice is a card with a radio, a label, an optional quiet marker, and one sentence on what the choice means. The parent owns the value.

Cards sit side by side while each gets 11rem, and stack on narrow surfaces such as a phone or a detail panel; cards in one row share their height. Each card has the field edge: 2 px grey at rest, a darker fill on hover, a strong blue edge on keyboard focus, and a light blue edge and fill when chosen, strong blue again when the chosen card has focus. A disabled list drops the edges. See [Controls stay platform blue](/en/ui/surfaces/color#controls-stay-platform-blue).

## Use ChoiceList

Use it when the person must understand the consequence of each choice before choosing, and there are only a handful of choices that should stay visible. A choice with consequences, such as how a job is billed or how often it repeats, is a card list, not a `SegmentedControl`; segments switch views. Use `ChoiceChips` for quick picks without explanation, `RichSelect` when the list is longer and belongs in a dropdown, `ChoiceTiles` when a preview decides faster than words, and `Switch` for a single on or off.

## Import

```tsx
import { ChoiceList, type ChoiceListOption } from "@k2b/ui";
```

## Options, markers, and details

`options` contain `value`, `label`, an optional `description`, and an optional `marker`. The controlled `value` is one option's value or `null`, which selects no row.

- `description` is one sentence under the label. Keep it to what changes for the person.
- `marker` is a quiet tag after the label, such as "Default" on the choice that applies when the person has not chosen. It moves with the default, not with the selection.
- `details` are follow-up controls for the chosen card, such as a duration. They take the whole line under the chosen card's row of cards, aligned with the card text, and close when another card is chosen. Render them only when they belong to the current value.

Choosing changes only the card's edge, fill, and radio, so nothing moves. See [shared field props](/en/ui/getting-started#shared-field-props) for labels, descriptions, errors, disabled state, and value accessors.

## Save while choosing

When a choice saves at once, set `busy` while the save runs and name it with `busyLabel`. A spinner appears beside the chosen card's label, in a place every card keeps, so the label never shifts. The cards stay usable. When the save fails, set the value back to the saved one and say what applies next to the list, with a way to try again.

## Runtime

Selection and focus movement require browser code. Without it the cards render with their checked state, markers, and descriptions.

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

The cards are a radio group named by `label`, or by `aria-label` without a visible label, and described by `description`. Each card's sentence describes its radio. Only the chosen card is in the tab order; with no selection the first card is. Arrow keys move and select with wrapping, Home and End select the first and last card. While `busy`, the group is marked busy and the spinner carries `busyLabel`. On touch screens every card is at least 44 px high. In forced colors each card has a system outline, and the chosen one a thicker `Highlight` outline.
