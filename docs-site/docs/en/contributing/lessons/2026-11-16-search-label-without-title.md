### A table's search sign carried the view's title in its label

- **What happened:** The escape guard in `blocks.render.test.tsx` found a view's title, `<img src=x …>`, raw in the `aria-label` and `title` of the new search sign of a table in Gustav's answer.
- **Root cause:** The sign and the search field built their names from the view's title ("Search Stock"). A title is data that Gustav or a code run writes; an attribute is no place to repeat it.
- **Error class:** Data written into a control's name.
- **Guard:** The sign is named "Search table" ("Tabelle durchsuchen") and the field "Search table", and both point `aria-describedby` at the view's heading (`DataTableTools.describedBy`). The escape guard stays as it was; `view-block.browser.test.ts` checks the description.
