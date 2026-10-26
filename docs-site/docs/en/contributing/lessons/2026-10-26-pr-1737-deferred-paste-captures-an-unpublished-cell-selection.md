### Deferred paste captures an unpublished cell selection

- **What happened:** Native caret changes reach the table before selectionchange reaches CodeMirror; delayed parser loading then mistakes publication of the same caret for a changed target.
- **Root cause:** Deferred paste captures an unpublished cell selection.
- **Error class:** Deferred paste captures an unpublished cell selection
- **Guard:** Test: UI `clipboard-loading.browser.test.ts` publishes the old caret, moves the native selection and pastes in one browser task. The table synchronizes before target capture; peer edits, changed selection or focus, read-only state and disposal still preserve the paste as recovery.
