### An owner's detent change landed after the glide it interrupted

- **What happened:** The map dialog raises its phone sheet to half height when a place is picked, by setting `data-sheet-detent` itself. When a glide from the handle was still in flight, the sheet first landed on the glide's old detent and then jumped to the new one; the same timing made the map dialog's grip test read the sheet mid-move (see the lesson for #3391).
- **Root cause:** Since #3360 `attachSheetHandle` sets the detent when a move starts and pins the layout height until the glide lands. It ignored detent changes it had not made itself while it moved, so the pinned glide finished on its own target.
- **Error class:** A second writer of the same state while a motion owns it, without the motion taking the new target.
- **Guard:** `sheet-handle.browser.test.ts` sets the detent mid-glide and samples every frame: the sheet never reaches the old target, no frame drops by a jump, and it rests on the new detent.
