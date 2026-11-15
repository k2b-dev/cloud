### The Files selection pill hung under a short list instead of at the column's end

- **What happened:** With a few files selected, the selection pill sat directly under the last row and left the column empty below it. At the end of a long list, the appearing pill covered the last row, and clearing the selection made every row jump.
- **Root cause:** The floating toolbar's strip reaches the column's end through `margin-block-start: auto`, which works only in a flex column. Files placed it in a block `ScrollArea`, where it followed the rows. It was also mounted only during a selection, so its reserved height came and went with the pill.
- **Error class:** A sticky or auto-margin placement relies on a host layout its container does not have, and a conditional floating element changes the scroll height.
- **Guard:** `packages/filesv2/src/frontend/Selection.browser.test.ts` ("Files selection pill at the bottom of the column") checks the pill's distance to the column's end, the last row's clearance, and unchanged row positions on desktop and phone, with few and many files, in the list, grid, and tree.
