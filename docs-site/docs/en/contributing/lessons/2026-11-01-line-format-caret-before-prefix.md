### Text typed after a line format landed in front of its prefix

- **What happened:** On an empty line, choosing a heading, list or quote and typing produced `Kapitel# ` instead of a heading.
- **Root cause:** The shared line commands inserted the prefix at the line start and left the selection unmapped, so a caret at that position stayed in front of the insertion.
- **Error class:** An insertion at the caret position keeps the caret on the wrong side unless the change maps it explicitly.
- **Guard:** The commands map the selection with forward association. A behavior test in `packages/editor` checks the caret for each line format, and the Notes slash menu browser test types into each block it inserts.
