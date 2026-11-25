### A table above a stacked side column drew a double line on the phone

- **What happened:** On the v2 agent page (#4110) at 390 px, the side column stood under the table of keys, and the line under the last key and the seam above the side column met as two lines. The page's test had to name the finding as a known exception.
- **Root cause:** The phone rule that lets the last line of a pane give way to the seam knew rows, lists and sections, but not a `Table`: neither its phone rows nor the rows of a large table.
- **Error class:** A primitive that ends a pane is missing from a rule that lists the endings of a pane, so the gap shows only on the first page that puts it there.
- **Guard:** The `access` fixture in `packages/ui/test/v2-fixtures.tsx` ends a pane with a table above a side column; `packages/ui/src/v2/primitives.browser.test.ts` measures it at 390 px, where `measureV2Layout` reports the double line.
