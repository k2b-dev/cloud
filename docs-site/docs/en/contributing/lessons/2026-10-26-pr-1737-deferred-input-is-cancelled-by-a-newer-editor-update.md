### Deferred input is cancelled by a newer editor update

- **What happened:** Android EditContext can apply the next typed character before a deferred Enter runs, joining two intended lines.
- **Root cause:** Deferred input is cancelled by a newer editor update.
- **Error class:** Deferred input is cancelled by a newer editor update
- **Guard:** Tests: Notebooks `shared-text-editor.browser.test.ts` sends native Enter immediately followed by typing and checks the newline, list keymap, and slash command in the actual shared editor.
