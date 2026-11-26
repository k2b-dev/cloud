### The head's actions ran over the card's edge

- **What happened:** In Mail's admin, a head with a long subject squeezed its actions: the buttons and the "…" menu
  ran over the edge of the card at 1440 px and at 390 px. In a table, a long name beside its avatar and chip in one
  `Inline` pushed the chip out of the cell, where it was cut.
- **Root cause:** The end of a bar kept the default `flex-shrink: 1` with `min-width: 0`, so a long start shrank it
  below the width of its buttons, which do not shrink. In a cell, every thing in an `Inline` kept its size, the name
  too, so the line clipped what came after the name.
- **Error class:** A group of fixed-size controls or marks that shares a line with text and is allowed to shrink, or
  text that is not, so the controls give way instead of the text.
- **Guard:** The end of a bar never shrinks (`flex: none`), and in a cell the name gives way (it wraps, or ends with
  "…" in a table with column widths). `measureV2Layout` reports a control that sticks out of a bar or pane (`out`),
  which it missed before. `head-overflow.browser.test.ts` draws a long subject in a workspace head and a pane head,
  and worst-case names beside their marks, at 1440 px and 390 px.
