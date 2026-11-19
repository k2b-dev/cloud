# ChoiceList

`ChoiceList` picks one value from a few choices that each need a sentence, such as how often something notifies you or who may see it. By default, each choice is a card with a radio, a label, an optional quiet marker, and one sentence on what the choice means. Use `variant="list"` for compact rows in one frame. The parent owns the value.

With `variant="cards"` (the default), cards sit side by side while each gets 11rem, and stack on narrow surfaces such as a phone or a detail panel; cards in one row share their height. Each card has the field edge: 1 px grey at rest, a darker edge and fill on hover, a strong blue edge with the soft focus ring on keyboard focus, and a second blue line inside the edge (2 px in all) with a light blue fill when chosen. A disabled list shows light edges on a muted fill. See [Controls stay platform blue](/en/ui/surfaces/color#controls-stay-platform-blue).

## Use ChoiceList

Use it when the person must understand the consequence of each choice before choosing, and there are only a handful of choices that should stay visible. A choice with consequences, such as how a job is billed or how often it repeats, is a card list, not a `SegmentedControl`; segments switch views. Use `ChoiceChips` for quick picks without explanation, `RichSelect` when the list is longer and belongs in a dropdown, `ChoiceTiles` when a preview decides faster than words, and `Switch` for a single on or off.

## Compact framed rows

Use `variant="list"` for a few short reasons or alternatives that people can scan together. Each entire row is clickable, with a 16 px radio on the left, 14 px text, and a fine separator. The shared control radius rounds the outer frame. The chosen row has the platform selection fill and a semibold label; keyboard focus draws one inset ring. There are no shadows.

Short descriptions sit beside the label in muted text. Long labels and descriptions wrap, including unbroken words, instead of truncating a reason someone needs to read. A row is at least 38 px high with a fine pointer and 44 px on touch devices; wrapped content can make it taller. There is no `size` prop.

A disabled row stays muted with its full reason readable in `description`. Icons remain optional: omit them for familiar reasons, or give every row an icon when the pictures help distinguish the choices. Compare both live examples below.

In this variant, `details` appears **below the whole framed block, outside its border**, when the value matches an option. Render it only for the value that needs follow-up input. Opening, changing, or closing details leaves the frame and every row in place; only content below it moves. In the default cards variant, details still appears under the chosen card's row.

```tsx
const [reason, setReason] = createSignal<string | null>("return");
const [note, setNote] = createSignal("");

<ChoiceList
  variant="list"
  label="Why not bill yet?"
  value={reason}
  onValueChange={setReason}
  options={[
    { value: "return", label: "Buyer is returning it" },
    { value: "cancel", label: "Purchase is being cancelled" },
    { value: "relist", label: "Will be relisted", disabled: true, description: "Return still pending" },
    { value: "other", label: "Another reason" },
  ]}
  details={reason() === "other" ? <TextInput label="Reason" value={note} onValueChange={setNote} /> : undefined}
/>
```

## Import

```tsx
import { ChoiceList, type ChoiceListOption } from "@k2b/ui";
```

## Options, markers, and details

`options` contain `value`, `label`, and optionally `description`, `descriptionVisual`, `marker`, `icon`, and `disabled`. `descriptionVisual` shows in place of the description text, as in [Select](select#show-a-visual-in-place-of-the-description). The controlled `value` is one option's value or `null`, which selects no row.

- `description` is one sentence under the label in cards, or a short addition beside it in the list variant. Keep it to what changes for the person.
- `marker` is a quiet tag after the label, such as "Default" on the choice that applies when the person has not chosen. It moves with the default, not with the selection.
- `icon` is a Tabler icon class shown between the radio and the label, such as `ti ti-truck`, when a picture helps tell the choices apart. It is muted at rest and takes the action ink on the chosen card. Give every option an icon or none.
- `disabled` keeps a choice visible that is not possible now. In cards, it drops its edge; in the list, it keeps the shared frame and muted ink. Say why in its `description`, such as "Only within the city; this address is outside." A disabled option that is the current value still shows as chosen.
- `details` are follow-up controls for the chosen value, such as a duration. In `variant="list"` they follow the entire frame. In cards, they take the whole line under the chosen card's row of cards, aligned with the card text, and close when another card is chosen. Render them only when they belong to the current value.

Choosing leaves the cards or rows in place. See [shared field props](/en/ui/getting-started#shared-field-props) for labels, descriptions, errors, disabled state, and value accessors.

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
type ChoiceListOption<T extends string = string> = {
  value: T; label: string; description?: string; descriptionVisual?: () => JSX.Element; marker?: string; icon?: string; disabled?: boolean;
};

type ChoiceListProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly ChoiceListOption<T>[];
  variant?: "cards" | "list";
  busy?: boolean;
  busyLabel?: string;
  details?: JSX.Element;
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};
```

## Accessibility

Both variants are a radio group named by `label`, or by `aria-label` without a visible label, and described by `description`. Each card's sentence describes its radio. Only the chosen card is in the tab order; with no selection, or a disabled chosen card, the first card that can be chosen is. Space and Enter choose the focused option. Tab enters and leaves the group once (follow-up controls have their own tab stops). Arrow keys move and select with wrapping, Home and End select the first and last card; all three skip disabled cards, which keep their sentence as their description. Icons are decorative; the label names the choice. While `busy`, the group is marked busy and the spinner carries `busyLabel`. On touch screens every card is at least 44 px high. In forced colors each card has a system outline, and the chosen one a thicker `Highlight` outline.
