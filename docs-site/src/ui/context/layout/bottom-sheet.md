# BottomSheet

## Use BottomSheet

`BottomSheet` is the bottom-edge presentation of `PanelDialog`. Open it through
`dialogCore` with `bottomSheetOptions`. It reuses the existing focus trap,
Escape and backdrop handling, scroll lock, dialog stack, and dismiss guards.

## Import and example

```tsx
import { BottomSheet, bottomSheetOptions, dialogCore } from "@k2b/ui";

await dialogCore.open<void>((close, context) => (
  <BottomSheet onDismiss={context.requestDismiss}>
    <BottomSheet.Header title="Details" close={context.requestDismiss} />
    <BottomSheet.Body>Content</BottomSheet.Body>
    <BottomSheet.Footer>
      <button type="button" onClick={() => close()}>Done</button>
    </BottomSheet.Footer>
  </BottomSheet>
), bottomSheetOptions);
```

Pass `context.requestDismiss` to dismissal controls. `close(result)` completes
an operation; it deliberately bypasses cancellation guards. Register unsaved
state or pending-operation rules with `context.setDismissHandler`.

The handle is a keyboard-accessible button. A downward drag of more than 60 px
requests dismissal once. Dragging the body scrolls its content. There are no
snap points or second modal lifecycle. `dismissDisabled` disables the handle;
use the shared dismiss guard to protect Escape, backdrop, and header dismissal
as well. Set `handle={false}` to omit the handle, or `dismissLabel` to override
its inherited locale label.

`Header`, `Body`, `Footer`, `Section`, and `Tabs` use the same props as
`PanelDialog`. The sheet keeps one body scrollport, safe-area bottom padding,
a bounded viewport height, and a short entrance animation that respects reduced
motion. It is also usable on desktop; the host decides when to open it.

## Accessibility

Use a visible header title and meaningful dismiss labels. The native dialog
provides modal focus containment; the shared core restores focus on close.
Both the handle and header close control are keyboard-accessible.

## Runtime

This is a presentation primitive, not a second dialog manager. `dialogCore`
owns modal state and cancellation. Consumers own pending and dirty state.

## Example

The live draft editor demonstrates guarded dismissal. Type a name and dismiss
the sheet to exercise the discard confirmation; Save completes directly.
