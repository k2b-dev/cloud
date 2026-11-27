### Columns that may drop waited for the phone

- **What happened:** In Files at 1024 px with a file's detail open, the list beside it is about 550 px wide. Its
  columns that may drop ("Geändert", "Besitzer") still stood, and "Größe" at the end ran over the edge ("Gr…",
  "4,2…").
- **Root cause:** A column with `drop` dropped only in a pane narrower than 480 px, the phone's form. Between that and
  the width the columns need, a table kept every column and the last one, which takes the rest, got almost nothing.
- **Error class:** A part that gives way at one fixed width of its place, not at the width its own content needs.
- **Guard:** Each table writes, from its column widths, a container query of its own: a column that may drop drops
  where the columns still standing need more room than the table has, in their order. It is CSS, so the server and
  the first frame already show it. `table-drop.browser.test.ts` opens the detail at 1024 px and narrows the table
  step by step in Chromium and WebKit: the table fits, "Größe" keeps its words, and the columns drop one by one.
