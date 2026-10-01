# Hover preview

`HoverPreview` is a non-modal card that opens beside the item a resting mouse
points at. It shows a short look at that item without opening it. One card
serves a whole group of anchors, such as the rows of a list, and swaps its
content as the pointer moves from row to row.

## Use HoverPreview

Use it when people scan a list and want to check an item before they open it:
the start of a message, the facts of a record, or details of a navigation
entry. The card supplements the item; it never replaces opening it. Hovering
changes no state, so a preview must not mark anything as read or seen.

Keep the card to facts and a short excerpt. Use a `Tooltip` for a one-line hint
and a dialog or detail panel for work. Pointer and keyboard users must reach
everything in the card some other way, usually by opening the item.

`AppWorkspace.SidebarItem` uses the same card for its `preview`.

## Import

```tsx
import {
  createHoverPreview,
  HoverPreview,
  type HoverPreviewController,
  type HoverPreviewOptions,
  type HoverPreviewPlacement,
} from "@k2b/ui";
```

## Contracts

`createHoverPreview<T>(options)` creates the behavior for one group. Call it in
a component; the card lives as long as that component.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `openDelay` | `number` | `250` | Milliseconds a resting mouse waits on an anchor before the card opens. |
| `keyboard` | `"space" \| "focus"` | `"space"` | Space on the focused anchor toggles the card, or focus opens it after the delay. |
| `placement` | `HoverPreviewPlacement` | beside the anchor | Where the card opens; see below. |
| `disabled` | `(value: T) => boolean` | none | Anchors with a disabled value open no card. An open card closes once its value becomes disabled. |
| `onOpenChange` | `(open: boolean) => void` | none | Runs on every open and close, including light dismissal. |

The controller has these members:

| Member | Purpose |
| --- | --- |
| `anchor(value, trigger?)` | Returns a `ref` that registers an element as the anchor for `value`. `trigger` is the control focus returns to; it defaults to the anchor. |
| `active()` | The value whose card is open, or `undefined`. Use it for a row highlight or `aria-expanded`. |
| `toggle(value)` | Opens the card at once from a control and moves focus into it, or closes it when it is already pinned open. |
| `close()` | Closes the card. It opens again for the same anchor only after the pointer left it. |
| `id` | The card element id, for `aria-controls`. |

`<HoverPreview preview={…} label="…">` renders the card. A function child
receives the open anchor's value and renders when the card opens or swaps.
Plain children stay mounted while the card is closed. `size="fixed"` keeps one
22rem × 20rem box for every anchor, so content never resizes or moves the card;
the default sizes it to its content, 22rem wide and at most 32rem tall. The card
adds no padding and clips its content; the content owns padding, line clamps,
and a fade at the bottom.

### Placement

By default the card opens to the right of its anchor, centered on it. With
`{ align: "end" }` its bottom edge aligns with the anchor instead. The card
flips to the left or clamps when the right side does not fit.

With `{ beside: () => listElement, within: () => frameElement }` the card opens
8px right of that region, top-aligned with the anchor, and is clamped into
`within` (default: the viewport) with an 8px margin. A card near the bottom
moves up until it fits. When there is no room for the card and both gaps right
of the region, it does not open at all, so it never covers the list.

### Timing

- A resting mouse opens the card after `openDelay`.
- With the card open, moving to another anchor swaps the content after 90 ms.
- The card stays open while the pointer moves into it. It closes 180 ms after
  the pointer leaves the anchor and the card.
- Escape closes the card. It reopens for that anchor only after the pointer
  left it.
- A card placed `beside` a region closes when that region or the page scrolls.
  A card beside its anchor follows it.

## Accessibility

Touch and pen input never open the card; it is a mouse affordance. Give touch
users the same information when they open the item.

The card is a non-modal `dialog` named by `label`. With the default
`keyboard="space"`, Space on a focused anchor toggles the card and focus stays
on the anchor; Enter keeps its meaning, such as following a link. Space on a
button, checkbox, or field inside the anchor keeps that control's own meaning.
While the card is open, focusing another anchor of the group moves the card
there. With `keyboard="focus"`, focus on an anchor opens the card after the delay.

`toggle(value)` moves focus into the card so interactive content is reachable.
Escape with focus inside the card returns it to the trigger and shows the focus
ring when the keyboard opened it. Escape from a card that only the pointer
opened leaves the key to other handlers, such as an open modeless dialog.

## Runtime

The card renders on the server as a closed native popover (`popover="auto"`),
so outside clicks and other popovers dismiss it. Hydration registers the anchors
and positions the card in the top layer; it never changes the layout of the
anchors or anything around them. The card uses the elevated surface, a strong
border, and inner depth only: no outer shadow and no divider lines. It fades in
and out unless reduced motion is requested.

## Example

```tsx
const preview = createHoverPreview<string>({
  openDelay: 200,
  placement: { beside: () => list, within: () => frame },
  disabled: (id) => id === openConversationId(),
});

<div ref={list} role="list">
  <For each={conversations()}>
    {(item) => (
      <div ref={preview.anchor(item.id)} role="listitem" data-peek={preview.active() === item.id}>
        <a href={item.href}>{item.subject}</a>
      </div>
    )}
  </For>
</div>
<HoverPreview preview={preview} label="Quick look" size="fixed">
  {(id) => <ConversationCard id={id} />}
</HoverPreview>
```
