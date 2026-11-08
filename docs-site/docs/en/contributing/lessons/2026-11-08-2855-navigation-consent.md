### End discard consent when another navigation guard keeps the page open

- **What happened:** A page guard registered before a lazy image editor could stop its confirmed navigation retry without notifying that editor. The editor then suppressed the unload warning for edits that were still unsaved.
- **Root cause:** The navigation checks stop at the first veto. Observing a later editor's restoration promise cannot see an earlier guard's veto.
- **Error class:** A partial guard chain is mistaken for an accepted navigation.
- **Guard:** `packages/ui/test/image-editor.browser.test.ts` registers foreign guards before and after editors and verifies that a veto preserves dirty state, restores the unload warning, and asks again on the next attempt. The two-editor and Files regressions confirm one discard and cancel another, preserving every unsaved session. Files waits for the unsaved strip labels before counting them.
