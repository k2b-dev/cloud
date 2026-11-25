### A sticky v2 table started its cells 8 px left of its head

- **What happened:** The first filtered list on `@k2b/ui/v2` (gateway-ops Logs, a `Table` with `sticky`) showed every body cell of the first column 8 px left of the column head and the group rows, and every cell of the last column 8 px right of its head, at every width.
- **Root cause:** The large table's cell rule set `padding: 0 12px` to drop the vertical padding of two-line cells. It has the same specificity as the rule that puts the first and the last cell on the text edge of 20 px and comes later, so it reset their side padding to 12 px; the head cells never had that rule and kept the edge.
- **Error class:** A shorthand that should change one side of a box resets every side, and a later rule of equal specificity silently undoes an edge contract set earlier.
- **Guard:** The large table's cells now set only `padding-block`. `packages/ui/src/v2/status-table.browser.test.ts` checks at 1440, 1024 and 700 px that body, head and group rows of a sticky table start on the 20 px text edge and that body and head end on one edge, in Chromium and WebKit.
