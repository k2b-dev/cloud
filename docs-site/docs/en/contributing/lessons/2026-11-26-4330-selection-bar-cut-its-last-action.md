### The selection bar cut its last action

- **What happened:** In Files at 1440 px, the list beside the sidebar is 1117 px wide. With twelve files selected, the
  status row's bar of what can be done with them showed the count and seven actions, which need more room than that,
  so "In den Papierkorb" was cut at the row's edge.
- **Root cause:** The selection bar set its actions side by side as plain buttons. They gave way only by the width of
  the column: symbols only below 600 px, the way out as × below 400 px. Nothing moved an action that did not fit
  elsewhere, so in a wide column with many actions the last ones ran out of the row.
- **Error class:** A row of controls that gives way only at fixed widths, not by what it holds, so enough controls
  overflow it at any width.
- **Guard:** The selection bar folds its actions with the bar's fold (`watchFold`, the same one every `Bar` end uses):
  the ones without room go whole into a "…" menu from the end, measured from the actions' own widths, and the focus
  of an action that hides goes to the "…", and back to the last action in sight when the "…" goes.
  `status-table.browser.test.ts` draws seven actions at 1117 px, 1024 px and 390 px, then a pixel beyond and a pixel
  short of the width they need measured in the browser, and back, so the fold is proven in every engine's fonts. The
  count is never cut, each action in sight is whole, the "…" stands right after the last one, the way out stays at the
  end, and the actions in sight and in the menu are all seven, in their order.
