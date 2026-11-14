# BottomSheet

## Use BottomSheet

`BottomSheet` is the bottom-edge presentation of `PanelDialog`. Open it through
`dialogCore` with `bottomSheetOptions`. It reuses the existing focus trap,
Escape and backdrop handling, scroll lock, dialog stack, and dismiss guards.

## Sheet or dialog

Menus, pickers, and navigation that belong to the bottom edge on a phone use
`bottomSheetOptions` at every width, or the host opens them only on phones.
Decisions, confirmations, and short forms use `bottomSheetAdaptiveOptions`:
a sheet below 48rem and a centered 32rem dialog from 48rem up.
CSS chooses the mode, so server and client agree from the first frame and
rotation switches the open dialog in place. Dialog mode has no handle;
provide a footer action or a header close control.

Wide or fixed-height editors keep `panelDialogWideOptions` or
`panelDialogFixedOptions`; see [PanelDialog](/en/ui/layout/panel-dialog).
An ending should replace the request and its actions in place without resizing
the dialog. Reserve enough space for the ending and move focus to Done.

## Import and example

```tsx
import { BottomSheet, Button, bottomSheetAdaptiveOptions, dialogCore } from "@k2b/ui";

await dialogCore.open<void>((close, context) => (
  <BottomSheet onDismiss={context.requestDismiss}>
    <BottomSheet.Header title="Details" close={context.requestDismiss} />
    <BottomSheet.Body>Content</BottomSheet.Body>
    <BottomSheet.Footer>
      <Button onClick={() => close()}>Done</Button>
    </BottomSheet.Footer>
  </BottomSheet>
), bottomSheetAdaptiveOptions);
```

Pass `context.requestDismiss` to dismissal controls. `close(result)` completes
an operation; it deliberately bypasses cancellation guards. Register unsaved
state or pending-operation rules with `context.setDismissHandler`.

In sheet mode, the sheet follows the finger. The handle is a keyboard-accessible
button: a press closes the sheet, sliding it out first, and a drag on the
handle or the header follows the pointer. A finger moves the sheet from
anywhere in it, except where a list can still scroll: in a scrolled list the
finger scrolls first, and only at the list's top does a downward pull move the
sheet. On release the sheet returns to its rest or closes, by distance and
speed: below its rest, a release more than a quarter down or faster than
0.4 px/ms closes it, and a flick faster than 2 px/ms closes it from anywhere.
The click that ends a drag presses nothing. `dismissDisabled` disables the
handle's close and keeps the sheet from being dragged below its rest; use the
shared dismiss guard to protect Escape, backdrop, and header dismissal as
well. When a guard keeps the sheet after a drag or a press, it slides back.
Set `handle={false}` to omit the handle, which also leaves the sheet in place,
or `dismissLabel` to override its inherited locale label. `tone` gives the
sheet a [dialog tone](/en/ui/layout/panel-dialog#tone); on a phone the edge
runs along all four sides of the sheet.

`Header`, `Body`, `Footer`, `Section`, and `Tabs` use the same props as
`PanelDialog`. The sheet keeps one body scrollport and a bounded viewport
height. It is also usable on desktop; the host decides when to open it.

## Motion

A sheet moves only by transform and opacity. Its layout height is fixed when
it opens, the content's height or, with detents, the full height, and it never
animates. It slides up from below the edge and lands directly on its rest,
without overshoot or settle: 280 ms with `--k2b-ease-out`, 220 ms to close,
instant with reduced motion. The frame clips with `overflow: clip`, never
`hidden`, because a hidden box still scrolls and focus scrolling it would
cancel the slide. Behind a sheet the page only dims, without blur, and the dim
follows the sheet below its rest; a centred dialog keeps its blur.

## Detents

Pass `detents` for a long list or a form that benefits from a preview, such as
a folder picker. The sheet then opens at half the screen's height and rests at
half or full height (92% of the screen); menus and date sheets keep their
content's height.

```tsx
<BottomSheet detents onDismiss={context.requestDismiss}>
```

- At half height the end of the list lies below the edge. A drag up, the mouse
  wheel, or Tab into the list brings the sheet to full height first.
- The handle names the way it goes ("Expand to full height", "Shrink to half
  height"); a press switches, and ArrowUp and ArrowDown move it.
- A release faster than 0.4 px/ms goes one detent in its direction; a slower
  one goes to the nearest detent after a short projection.
- The footer stays on the screen's edge between half and full height and rides
  along below half height.

From 48rem an adaptive sheet with detents is the usual centred dialog with its
content's height.

The sheet sits on the bottom edge and respects the bottom safe area. When a
`Footer` is the last part of the sheet, the footer carries that inset: its
surface reaches the physical screen edge and its actions stay above the home
indicator. Otherwise, the sheet pads its content by the inset. Installed web
apps need `viewport-fit=cover` in their viewport meta tag for the inset to
apply.

## Drag a non-modal sheet between heights

A sheet that is not a dialog, such as Cloud's panel on a phone, can rest at
more than one height. `attachSheetHandle(handle, options)` turns its handle
button into a drag handle between named heights (detents):

```ts
import { attachSheetHandle } from "@k2b/ui";

const dispose = attachSheetHandle(handle, {
  sheet,
  detents: ["half", "full"],
  initial: "full",
  onChange: (detent) => handle.setAttribute("aria-label", detent === "full" ? "Shrink panel" : "Enlarge panel"),
  onDismiss: close,
});
```

The sheet carries the current detent in `data-sheet-detent`; the stylesheet
gives each detent its height, and `initial` names the height the stylesheet
draws while the attribute is absent, as in the server's markup. So the first
frame is right without script, and a rotation moves the sheet with CSS
alone. List `detents` from the lowest height to the highest.

- A press, by pointer, Enter, or Space, moves the sheet to the next detent up,
  and from the highest back to the lowest. The handle stays a button in the
  tab order; rename it in `onChange` so its name says which way it goes.
- A drag follows the pointer with an inline height and sets
  `data-sheet-dragging` on the sheet. On release the sheet snaps to the
  nearest detent, taking the pointer's speed into account; a pointer that
  rested before it lifted carries no speed. The click after a drag does not
  move the sheet again.
- Without `onDismiss`, the drag stops at the lowest detent. With it, a release
  well below the lowest detent calls `onDismiss` instead; keep the sheet's
  own close path behind it, including its guards.
- The handle gets `touch-action: none`, so a drag on a touch screen moves the
  sheet and never scrolls the page.

Give the sheet a `height` transition with `--k2b-motion-sheet`: the snap uses
it, a drag turns it off with an inline style, and reduced motion, from the
system or `data-k2b-motion="reduced"`, makes the snap instant. The function
returns a disposer that removes its listeners and inline styles.

## Accessibility

Use a visible header title and meaningful dismiss labels. The native dialog
provides modal focus containment; the shared core restores focus on close.
Initial focus goes to the first input in the sheet and otherwise moves to the
dialog itself, which never draws a ring. The handle never keeps initial focus,
even though native `showModal()` focuses it first, so a sheet that opens
without a user gesture (for example from a notification) shows no focus ring.
Visible controls stay in the tab order and show a ring on keyboard focus.
In adaptive dialog mode, the hidden handle is also removed from the tab order.

## Runtime

This is a presentation primitive, not a second dialog manager. `dialogCore`
owns modal state and cancellation. Consumers own pending and dirty state.
Focus, Escape, backdrop dismissal, Back with `history: true`, reduced motion,
and safe-area handling apply in both modes. Adaptive dialog mode removes the
bottom inset because the frame is clear of the screen edge.

## Example

The live draft editor demonstrates guarded dismissal. Type a name and dismiss
the sheet to exercise the discard confirmation; Save completes directly.

The live decision example uses `bottomSheetAdaptiveOptions`. Resize while it
is open to switch between a sheet and a centered dialog.
