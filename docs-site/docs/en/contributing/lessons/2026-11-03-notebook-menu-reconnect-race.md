### Reactive menu state needs a wait, not a single read

- **What happened:** The Notebooks table-menu test failed in WebKit on an unrelated pull request: right after the harness reconnected, "Insert column right" still read `aria-disabled="true"`.
- **Root cause:** The test read the attribute once, immediately after opening the menu. The menu follows the connection state through a reactive update, so a slower engine could open it before the update landed.
- **Error class:** Asserting a reactive UI state with a one-shot read instead of waiting for the state.
- **Guard:** `shared-text-editor.browser.test.ts` now waits for the role-scoped menu item to reach the expected state with `getByRole(...).and(...).waitFor()` for both the offline and the reconnected case. A menu that never re-enables still fails the test.
