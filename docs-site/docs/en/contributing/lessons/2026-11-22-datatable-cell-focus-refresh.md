### A refreshed DataTable rebuilt every cell and dropped the focus inside it

- **What happened:** A `DataTable` with `getRowId` that received new row objects with the same ids (a live refresh) kept the row element and the focus on the row since #3990. Focus on a link or button that `renderCell` created inside a cell fell to `body` in Chromium and WebKit (#3996).
- **Root cause:** Each cell called `renderCell` with the current row object inside its insert effect. A new object, even with equal content, re-ran `renderCell` and replaced the cell's nodes.
- **Error class:** Keyed rendering keeps the outer element, but content below it still depends on object identity, so a refresh with equal data rebuilds focusable nodes.
- **Guard:** `packages/ui/src/content/data-table-focus.browser.test.ts` focuses a link and a button in a cell, passes new row objects with the same ids, and checks that the same element keeps focus while a changed row shows its new content. Cells now render from a per-row memo that compares plain data, so equal content keeps its cells.
