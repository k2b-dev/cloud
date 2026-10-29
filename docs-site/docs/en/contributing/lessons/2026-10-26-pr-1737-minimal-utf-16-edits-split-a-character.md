### Minimal UTF-16 edits split a character

- **What happened:** A common-prefix or common-suffix optimization edits half of a surrogate pair; Yjs replaces the split character with replacement glyphs.
- **Root cause:** Minimal UTF-16 edits split a character.
- **Error class:** Minimal UTF-16 edits split a character
- **Guard:** Test: UI `text-editor/markdown-table.test.ts` applies emoji replacements through real Y.Text splices and checks the resulting text. Both display differencing and final source trimming preserve complete surrogate pairs.
