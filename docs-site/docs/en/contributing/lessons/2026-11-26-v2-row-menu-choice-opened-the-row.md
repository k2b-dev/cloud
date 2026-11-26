### A choice in a v2 table row's menu also opened the row

- **What happened:** In Files on `@k2b/ui/v2`, choosing "Link widerrufen" in the "…" of a shares row also opened the row's folder. The page left the shares view, and the revoke that had just been confirmed was aborted with the page.
- **Root cause:** A `Table` row that opens something hands a click anywhere in the row on to its open link, unless the click was meant for a control in the row. The row recognised links, buttons and form fields, but not the entries of a `Menu`: the menu lies inside the row in the page (a popover in the top layer), so a click on an entry bubbled up to the row and opened it as well.
- **Error class:** A row-wide click handler that lists the controls it leaves alone forgets the controls that a control in the row opens, such as a menu or a popover.
- **Guard:** The row now also leaves alone clicks inside `[role=menu]` and `[popover]`. `packages/ui/src/v2/row-menu.browser.test.ts` chooses an entry in a row's menu and checks that the row does not open, and that a click on the row itself still does.
