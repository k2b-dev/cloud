### The head's actions ran over the card's edge, and nothing measured it

- **What happened:** In Mail's admin, a head with a long subject squeezed its actions: the buttons and the "…" menu
  ran over the edge of the card at 1440 px and at 390 px. In a table, a long name beside its avatar and chip in one
  `Inline` pushed the chip out of the cell, where it was cut, also in the first cell, which holds the row's link.
  `measureV2Layout` reported neither.
- **Root cause:** The end of a bar could shrink below the width of its buttons, which do not shrink (#4392 lets the
  end fold its buttons into a menu). In a cell, every thing in an `Inline` kept its size, the name too, so the line
  clipped what came after the name. The layout measurement only checked a control's label, not whether the control
  stays inside its bar or pane.
- **Error class:** A group of fixed-size controls or marks that shares a line with text and is allowed to shrink, or
  text that is not, so the controls give way instead of the text; and a measurement that sees inside a control but
  not around it.
- **Guard:** In a cell the name gives way (it wraps, or ends with "…" in a table with column widths; a wrap column
  keeps its three lines), in a linked first cell too. `measureV2Layout` reports a control that sticks out of a bar or
  pane (`out`). `head-overflow.browser.test.ts` draws worst-case names beside their marks in a linked table at
  1440 px, and holds the head's case for #4392 (skipped until it lands).
