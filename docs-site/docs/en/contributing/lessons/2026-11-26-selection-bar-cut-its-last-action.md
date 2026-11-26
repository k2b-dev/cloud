### The selection bar cut its last action

- **What happened:** In Files at 1440 px, the list beside the sidebar is 1117 px wide. With twelve files selected, the
  status row's bar of what can be done with them showed the count and seven actions, which need about 1290 px, so "In
  den Papierkorb" was cut at the row's edge.
- **Root cause:** The selection bar set its actions side by side as plain buttons. They gave way only by the width of
  the column: symbols only below 600 px, the way out as × below 400 px. Nothing moved an action that did not fit
  elsewhere, so in a wide column with many actions the last ones ran out of the row.
- **Error class:** A row of controls that gives way only at fixed widths, not by what it holds, so enough controls
  overflow it at any width.
- **Guard:** The actions stand on one line that hides what wraps; the browser counts how many fit, as the tabs of a
  head do, and the rest go whole into a "…" menu from the end. `status-table.browser.test.ts` draws seven actions at
  1117 px and 1024 px (window 1440) and at 390 px. The count is never cut, each action in sight is whole, the way out
  stays, and the actions in sight and in the menu are all seven, in their order. At 1024 px and 390 px some must be in
  the menu; at 1117 px that depends on the font's widths.
