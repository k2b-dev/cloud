### The floating main action covered the last row on the phone

- **What happened:** In the Weather v4 images at 390 px, the floating "Ort hinzufügen" covered the last day of the week, so its rain share could not be read even when scrolled to the end. Every v2 workspace with a `primary` action had the same flaw on the phone.
- **Root cause:** The floating action is placed over the page (`position: absolute`, 16 px from the bottom), but the scrolling content ended at the page's edge. Nothing left room under the last row.
- **Error class:** A floating control over scrolling content without matching room at the content's end.
- **Guard:** On the phone, the outermost pane of a workspace with a floating action ends in an 80 px spacer, and so does the last pane of a split in that place (`packages/ui/src/v2/v2.css`). `packages/ui/src/v2/fab-room.browser.test.ts` scrolls a long pane and a split to the end at 390 px and checks that the last row stands at least 8 px above the button; at 1440 px there is no spacer.
