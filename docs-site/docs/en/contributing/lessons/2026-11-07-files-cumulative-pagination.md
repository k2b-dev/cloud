### Keep appended Files pages in navigation state

- **What happened:** Files replaced the folder contents when the reader requested the next page.
- **Root cause:** The folder footer linked to a new cursor address; the navigation loader returned only that page.
- **Error class:** List continuation without a restorable cumulative window.
- **CI capacity:** Register the new browser suite's measured WebKit weight (10.2 seconds). Sixteen shards fit the unchanged 11-minute target; fifteen exceeded it. Run `scripts/test-weights.test.ts` and `scripts/run-tests.test.ts` when adding a browser suite so the current matrix covers its cost.
- **Guard:** `directory-pages.test.ts` checks replay, append, cancellation and retry; `Pagination.browser.test.ts` checks keyboard focus, stable loading, recovery, reload and Back at desktop and phone widths, plus one listing pass per background refresh. `files-ui.behavior.test.tsx` checks that a failed download retains every directory entry and allows retry without navigation; its footer assertion follows the new button contract so it reaches the download failure checks.
