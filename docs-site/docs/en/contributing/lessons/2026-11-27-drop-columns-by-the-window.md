### A table's columns gave way by the window, not by the table

- **What happened:** In Files at 1024 px with a file's detail open, the list beside it is about 550 px wide. Its
  columns that may drop ("Geändert", "Besitzer") still stood, and "Größe" at the end ran over the edge ("Gr…",
  "4,2…"). In Spaces' admin at 1440 px the description was cut at its 250 px while the last column, "Settings",
  stood very wide, and at 1024 px a table wider than its pane was cut at the pane's edge without "…" or any cue that
  it scrolls.
- **Root cause:** A column with `drop` dropped only in a pane narrower than 480 px, the phone's form. The last column
  always took the room that was left, whatever it held, so a short last column grew and a text column did not, and a
  last column with too little room was squeezed below what it needs. A table that had to scroll hid its scrollbar
  and showed nothing at its edge.
- **Error class:** A part that gives way at one fixed width of its place, or by its position, not by what its own
  content needs.
- **Guard:** Each table writes, from its column widths, a container query of its own: a column that may drop drops
  where the columns still standing need more room than the table has, in their order, already on the server. One
  column grows: the one with `grow`, else the widest that holds no number. A table never gets narrower than its
  columns need; then it scrolls with a fading edge and a thin scrollbar. `table-drop.browser.test.ts` and
  `table-columns.browser.test.ts` check this at 1024 px and 1440 px in Chromium and WebKit.
