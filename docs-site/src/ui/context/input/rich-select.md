# RichSelect

`RichSelect` is a controlled dropdown picker whose rows explain each choice.
It selects one value or reports an action while the parent keeps `value` at
`null`. An optional preview explains the consequences of the active option.

## Use RichSelect

Use it when the person needs a name plus a short explanation or an unavailable
reason to choose: a move destination, a sender identity, or a sharing level.
See [Select inputs](select#which-dropdown-when) for the other dropdowns.

A preview pays off when an option has several consequences that change the
choice and those consequences differ per option. When a one-line description
says the difference, there is no preview.

A mail sender can change the signature, sent-mail visibility, and reply address,
so a preview helps. A sharing level needs one line per level; omit the preview.

### Keep rows short

- Give each option a name and at most one short explanatory line. Do not add
  badges or keyboard hints to the picker.
- Text wraps; it never truncates. A short line is a writing constraint, not a
  CSS line clamp.
- An unavailable option uses `disabledReason` in place of `description`.
  Keep the reason specific, such as **No write access**.
- Use one visual: `visual` takes precedence over `color`, which replaces `icon`.
  Supply a render function, for example `visual: () => <Avatar name="Anna" />`,
  so the trigger, list and preview each receive their own DOM element.
  Names must make sense without the visual.
- Search and section headings appear only from eight options. Search matches
  label, description, value, and `keywords`, ignoring case. Keep items from
  each section together; `sections` supplies the heading labels.
- Keep the preview to at most three facts. `RichSelectFacts` enforces this by
  rendering only its first three facts; `tone="warning"` highlights a consequence.
  The desktop preview has a fixed size while open, with scrolling for overflow.

## Import

```tsx
import {
  RichSelect,
  RichSelectFacts,
  type RichSelectFact,
  type RichSelectFooter,
  type RichSelectItem,
  type RichSelectProps,
  type RichSelectSection,
  type RichSelectStatus,
} from "@k2b/ui";
```

## States and footer actions

`status` defaults to `"ready"`. `"loading"` shows four placeholder rows, a
preview placeholder when applicable, and a busy list. `"error"` shows
**Could not be loaded.** and a **Retry** button when `onRetry` is supplied.
Retry calls the consumer; the consumer owns loading, errors, and the items.
If an update removes the focused search, Retry, or footer control, focus returns
to the trigger on desktop or the sheet on a phone.

A ready list with no items shows `empty`, or **No options available** by default.
A search with no matches shows **No results found**. Built-in messages inherit
the UI locale (English or German); the application owns item and preview text.

A footer with `onActivate` closes the picker before running the action.
A footer with `create` turns into an input and **Create** button, prefilled
with the search query. Enter submits a trimmed, nonempty name to `onCreate`
after closing. Escape returns to the footer button. The footer remains available
in a ready list with no items, so a person can create the first item.
Creating an item does not submit a surrounding form.

## Keyboard

On desktop, Enter, Space, or either arrow key opens the picker. ArrowUp and
ArrowDown move through all visible rows and wrap, including unavailable rows.
Home and End move to the first and last row. Enter chooses the active enabled
row; on an unavailable row it does nothing and the list stays open.

Escape closes the picker and returns focus to the trigger. When search is
present, printable keys from the trigger or preview go to the search field and
filter the list. Moving the pointer over a row updates the active preview;
clicking an enabled row chooses it.

## Phone behavior

At widths up to `47.999rem`, opening uses a bottom sheet with a list of choose
buttons. The viewport at open time decides which presentation is used.
With a preview, each row also has a `Details: <label>` info button, including
unavailable rows. It opens a second level with the item name, preview, Back,
and a full-width **Choose** button. Choose is disabled for an unavailable item.
Back or Escape returns to the list and focuses that row's info button.
The detail follows the current items: a new unavailable reason disables Choose;
removing the item returns to the list.

Choosing an enabled item closes the sheet before reporting its value. The
sheet participates in dialog history, so browser Back also dismisses it.
The opening focus stays on the sheet to avoid opening the phone keyboard.

## API reference

`RichSelectProps` extends [shared field props](/en/ui/getting-started#shared-field-props):
`id`, `class`, `label`, `description`, reactive `error`, `required`, `disabled`,
`aria-label`, and `aria-describedby`. Its required `value` is a string or `null`,
or an accessor returning either. Each selection reports the same value through
both optional `onValueChange` and `onValueCommit` callbacks.

```ts
type RichSelectItem = {
  value: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  visual?: () => JSX.Element;
  disabledReason?: string;
  section?: string;
  keywords?: readonly string[];
};

type RichSelectSection = { id: string; label: string };
type RichSelectStatus = "ready" | "loading" | "error";

type RichSelectFooter =
  | { label: string; icon?: string; onActivate: () => void }
  | {
      label: string;
      icon?: string;
      create: { placeholder: string; onCreate: (name: string) => void };
    };

type RichSelectFact = {
  icon: string;
  text: JSX.Element;
  tone?: "default" | "warning";
};

type RichSelectProps = ValueFieldProps<string | null> & {
  items: readonly RichSelectItem[];
  sections?: readonly RichSelectSection[];
  title?: string;
  placeholder?: string;
  triggerLabel?: string;
  icon?: string;
  tone?: "default" | "warning";
  renderTrigger?: (selected: RichSelectItem | undefined) => JSX.Element;
  renderPreview?: (item: RichSelectItem) => JSX.Element;
  searchPlaceholder?: string;
  status?: RichSelectStatus;
  onRetry?: () => void;
  empty?: JSX.Element;
  footer?: RichSelectFooter;
  appearance?: ChoiceAppearance;
  placement?: "bottom-start" | "top-start";
  size?: { width?: string; height?: string };
  name?: string;
};

function RichSelect(props: RichSelectProps): JSX.Element;
function RichSelectFacts(props: { facts: readonly RichSelectFact[] }): JSX.Element;
```

`title` names the listbox and phone sheet, and is a small heading above the
list when there is no preview. It falls back to a string `label`, `aria-label`,
`placeholder`, then **Choose option**. `placeholder` is the empty trigger text.
`triggerLabel` replaces the selected item's label in the trigger, for example
**Mara Example · mara@example.com**. `renderTrigger` replaces trigger content
while retaining its shared button and combobox semantics. `icon` supplies a
trigger icon when the selected item has no visual; `tone` defaults to
`"default"` and can be `"warning"`.

`appearance` uses [ChoiceAppearance](select#api-reference) and defaults to
`"field"`; `"plain"` uses the shared plain trigger. `placement` defaults to
`"bottom-start"`; `"top-start"` prefers above the trigger, flipping when the
other side has more room. `size` supplies desktop CSS width and height lengths.
Without overrides, the popover is `21.25rem` wide, or `37.5rem` with a preview.
With a preview its height is fixed at open time from the option count, between
`18.75rem` and `27.5rem`, constrained by the viewport. `searchPlaceholder`
defaults to **Search**. `name` adds a hidden form input with the selected value
(or an empty string for `null`).

## Accessibility

Give the trigger a visible `label` or an `aria-label`. On desktop it is a
combobox controlling a listbox. Focus stays on the trigger or search field;
`aria-activedescendant` identifies the active option. Rows expose
`aria-selected`; unavailable rows expose `aria-disabled="true"` and associate
the reason through `aria-describedby`. The active row also describes its
preview. Reasons remain readable because arrow keys reach unavailable rows.

The phone sheet uses a list with choose buttons. The selected button exposes
`aria-current`; unavailable buttons expose the reason and `aria-disabled`.
Their info buttons remain available. The sheet traps focus, names its detail
level, and restores focus on Back and on dismissal.

## Runtime

The trigger and selected value render in server HTML. Opening, positioning,
search, keyboard navigation, the preview interaction, and the phone sheet need
hydrated Solid client code. The parent owns the selected value and all data;
`RichSelect` has no dependency on Cloud services or domain models.
Setting `disabled` while the picker is open closes it and prevents selection.

## Not included

There is no `multiple` mode and no async items loader yet. Use `MultiSelectInput`
for multiple values or `Select` / `AutocompleteSelect` for remote loading until
a consumer needs those capabilities in `RichSelect`.

## Example

Fictional sender identities have different signatures, visibility, and replies.
The parent can also keep `value={null}` for an action picker such as moving a card.

```tsx
import { createSignal } from "solid-js";
import { RichSelect, RichSelectFacts, type RichSelectItem } from "@k2b/ui";

const senders: RichSelectItem[] = [
  { value: "mara", label: "Mara Example", description: "mara@example.com", icon: "ti ti-user" },
  { value: "support", label: "Support team", description: "support@example.com", icon: "ti ti-users" },
];
const [sender, setSender] = createSignal<string | null>("mara");

<RichSelect
  label="Send as"
  value={sender}
  onValueChange={setSender}
  items={senders}
  renderPreview={(item) => (
    <RichSelectFacts facts={[
      { icon: "ti ti-signature", text: item.value === "mara" ? "Personal signature" : "Support signature" },
      { icon: "ti ti-eye", text: item.value === "mara" ? "Only you see the sent mail" : "The support team sees the sent mail" },
      { icon: "ti ti-arrow-back", text: `Replies go to ${item.description}` },
    ]} />
  )}
/>;
```
