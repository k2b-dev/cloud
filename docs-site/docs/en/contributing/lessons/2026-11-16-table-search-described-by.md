### A table search could only name its table through its label

- **What happened:** A table whose name is data (a view title written by Gustav or a code run) had no safe way to name its search field: `DataTableTools` built the field's name only from `label` ("Search Stock"), so the data ended up in an attribute.
- **Root cause:** `DataTableTools` in `@k2b/ui` offered `label` as the only way to tie the search field to its table.
- **Error class:** Data written into a control's name because the component offered no reference to the element that already shows it.
- **Guard:** `DataTableTools.describedBy` points `aria-describedby` at the table's heading, so the label can stay a generic word; `data-table.render.test.tsx` checks that the attribute appears only when given.
