### A resting pointer starts hover transitions when the page moves content under it

- **What happened:** `AccessDialog.browser.test.ts` failed in CI at 390 px with `settled: the page kept animating` on a level trigger's `background-color`, in a pull request that did not touch the dialog.
- **Root cause:** After the test clicked **Dienstkonto hinzufügen**, the pointer stayed on that spot; the dialog then scrolled the identifier field into view by itself, a level trigger slid under the pointer, and its hover transition started while `settled` waited.
- **Error class:** A browser test settles after pointer input while the page itself scrolls or moves content, so hover transitions depend on timing.
- **Guard:** The test file settles after pointer input only through `settledAtRest`, which parks the pointer on the backdrop first, as `machine-permissions.browser.test.ts` and `ChatReactions.browser.test.ts` do.
