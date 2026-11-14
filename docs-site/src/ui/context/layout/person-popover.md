# PersonPopover

`PersonPopover` is a card about one person, anchored to the control that names
them, such as a sender in a message header. It shows the avatar, the name, one
secondary line, contact rows, an optional list such as earlier conversations,
and actions. It is built on `AnchoredPopover`.

## Use PersonPopover

Use it when a name on the screen should answer "who is this, and what can I do
with them?" without leaving the page. Use `AnchoredPopover` for other cards and
`Dropdown` for a menu without a person.

The application supplies every text and decides what the rows do. The card
owns the layout, the loading, partial, and error states, and the keyboard.

## Content

- **Head:** `Avatar` with initials or the `avatar` image, the `name`, and one
  `detail` line, such as "Lindqvist Holzbau · Owner". Without a `name`, the
  address heads the card and has the copy button.
- **Contact rows:** `email` with a copy button, and each of `phones` as a
  `tel:` link with an optional label, such as "Office".
- **List:** `list` adds a heading and link rows with a quiet second line, such
  as "Earlier conversations" with subject and date. An empty list hides the
  section unless `list.empty` gives a quiet line.
- **Actions:** `actions` are menu-like rows with an icon. Choosing a row or a
  list item runs `onSelect` or follows `href`, and closes the card.

## States

- **Loading:** `loading` keeps the head with what is known, such as the name
  and the address from a message, and puts placeholders where the detail line
  and one email and one phone row go. `list.loading` shows two placeholder
  rows. Placeholders have the size of the rows that replace them, so nothing
  moves when the data arrives. A hidden status announces the loading.
- **Partial:** without contact data, pass only the address. The card shows the
  address and the actions.
- **Error:** `error` replaces the contact rows with a quiet line and a retry
  button (`retryLabel`, or the shared "Retry"). `list.error` does the same for
  the list. The actions stay.

On a phone (below 48rem) the card is a bottom sheet across the screen.

## Accessibility

The card is a non-modal dialog named by `label`, or by the name or address.
Give the anchor `aria-haspopup="dialog"` and `aria-expanded`. When the card
opens, the focus moves into it. Arrow Up and Arrow Down move between its links
and buttons; Tab works as usual. Escape, a click outside, and another press of
the anchor close it and return the focus to the anchor.

## Import

```tsx
import { PersonPopover, type PersonPopoverAction } from "@k2b/ui";
```

## API reference

```ts
type PersonPopoverPhone = { number: string; label?: string };
type PersonPopoverLink = { label: string; meta?: string; href?: string; onSelect?: () => void };
type PersonPopoverAction = { label: string; icon?: string; href?: string; onSelect?: () => void; disabled?: boolean };
type PersonPopoverError = { message: string; onRetry: () => void; retryLabel?: string };
type PersonPopoverList = { title: string; items?: readonly PersonPopoverLink[]; loading?: boolean; error?: PersonPopoverError; empty?: string };

type PersonPopoverProps = {
  anchor: HTMLElement | null | undefined; onClose: () => void; label?: string;
  name?: string; avatar?: string | null; detail?: string; email?: string; phones?: readonly PersonPopoverPhone[];
  loading?: boolean; error?: PersonPopoverError; list?: PersonPopoverList; actions?: readonly PersonPopoverAction[];
  align?: "start" | "end"; side?: "below" | "above"; width?: string; class?: string;
};
```

`align` defaults to `start`, so the card lines up with the name that opened it.
`width` sets the desktop width; it defaults to the `AnchoredPopover` width.

## Runtime

Placement, the phone sheet, and focus need browser code. The server renders
nothing until an anchor is set.

## Example

```tsx
const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);

<button
  type="button"
  aria-haspopup="dialog"
  aria-expanded={anchor() !== null}
  onClick={(event) => setAnchor(anchor() ? null : event.currentTarget)}
>
  {sender.name}
</button>
<PersonPopover
  anchor={anchor()}
  onClose={() => setAnchor(null)}
  name={sender.name}
  email={sender.address}
  detail={contact()?.organization}
  phones={contact()?.phones}
  loading={contact.loading}
  error={contact.error ? { message: t().contactFailed, onRetry: refetch } : undefined}
  list={{ title: t().earlierConversations, items: conversations(), loading: conversations.loading }}
  actions={[
    { label: t().allFromSender, icon: "ti ti-search", onSelect: searchSender },
    { label: t().blockSender, icon: "ti ti-ban", onSelect: blockSender },
  ]}
/>
```
