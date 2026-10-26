### Selection escapes a nested editor

- **What happened:** Native Select All can select the outer note even while a table cell has focus. Replacing the selection then replaces the whole note.
- **Root cause:** Selection escapes a nested editor.
- **Error class:** Selection escapes a nested editor
- **Guard:** Tests: UI `text-editor.browser.test.ts` scopes Select All to a numeric cell; Notebooks `shared-text-editor.browser.test.ts` checks cell focus, unchanged surrounding Markdown, and recalculated formulas. The cell handles Select All explicitly.
