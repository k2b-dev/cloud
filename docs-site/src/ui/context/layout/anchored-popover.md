# AnchoredPopover

`AnchoredPopover` shows a card next to the control that opened it, such as a
model card with a slider in a composer. It is a non-modal dialog. The parent
owns whether it is open: it passes the anchor element, and `null` closes it.

## Use AnchoredPopover

Use it for content that is more than a menu but belongs to one control: a
short card with a slider, a summary and a link into a longer list. Use
`Dropdown` for actions, `RichSelect` for choosing one value from a list, and
`PanelDialog` or `BottomSheet` for a task that needs the whole attention.

- The card opens on the side with room and keeps that side while it is open.
  Pass `plannedHeight` when the content can grow, such as a list it switches
  to, so the side is chosen for the tallest content and the card never flips.
- Escape, a click outside and another press of the anchor close it. Focus
  moves into the card (`initialFocus`) and returns to where it was.
- On a phone (below 48rem) it is a bottom sheet across the screen. A short
  notice that must not cover its control, such as a dictation card, passes
  `sheet={false}` and stays beside the control inside the screen.
- `align` lines up the card's `start` or `end` edge with the anchor; `width`
  sets the desktop width, such as `21rem`.

## Accessibility

Give the anchor `aria-haspopup="dialog"` and `aria-expanded`, and give the card
a `label` that names the task; it is the dialog's accessible name. Focus moves
into the card when it opens and returns to the anchor when Escape, a click
outside or the anchor closes it. Content inside keeps its own keyboard
behaviour, such as a slider's arrow keys.

## Runtime

Placement, the phone sheet and focus need browser code. The server renders
nothing until an anchor is set, so the first frame has no card.

## Import

```tsx
import { AnchoredPopover } from "@k2b/ui";
```

## Example

```tsx
const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);

<Button
  aria-haspopup="dialog"
  aria-expanded={anchor() !== null}
  onClick={(event) => setAnchor(anchor() ? null : event.currentTarget)}
>
  Model
</Button>
<AnchoredPopover anchor={anchor()} onClose={() => setAnchor(null)} label="Choose a model" width="21rem" plannedHeight={520}>
  …
</AnchoredPopover>
```
