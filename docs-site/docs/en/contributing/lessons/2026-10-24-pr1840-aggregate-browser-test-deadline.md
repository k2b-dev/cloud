### An aggregate browser test ran out of time before its last device

- **What happened:** A shell and a permission-editor browser test mounted one device fixture after another inside one test until the shared deadline expired and closed a page still in use.
- **Root cause:** Independent device and width cases shared one test and one deadline, so the total grew with every device.
- **Error class:** Test deadline expires before the asserted boundary.
- **Guard:** Tests: `compact-shell.browser.test.ts` gives each device its own attachment, reload and navigation case; `PermissionEditor.browser.test.ts` separates each width, name and last-manager comparison. All assertions and timeouts remain unchanged.
