### An item of a row's menu opened the row

- **What happened:** In Mail's admin, a v2 table whose rows open their detail (`?open=`) had a "…" menu in each row.
  Choosing "Umbenennen" with the pointer opened the row's detail instead of the item's dialog (#4324 moved the
  actions into the detail head to get around it). The keyboard worked.
- **Root cause:** A menu's popup is a layer of its own (`popover`) but stands in the row's markup, so a click on one of
  its items bubbles to the row. The row hands a click on anything that is not a control on to its link, and a menu
  item is no `a` or `button`, so the row's link navigated before the item's dialog could open.
- **Error class:** A container that acts on clicks from its whole subtree, which also holds layers that only look
  outside it (menus, popovers, dialogs).
- **Guard:** The row hands a click on only from its own content: a click inside a `[popover]`, a dialog or a menu
  stays with that layer. `table-row-menu.browser.test.ts` chooses the item by pointer and by key in Chromium and
  WebKit, checks the dialog, that the row's link did not move, the focus back on the menu's button, and that the row
  still opens by a click on it. Mail's own repro (`table-row-menu.repro.browser.test.ts`) checks the same table with
  and without row links on a real origin.
