### Wait for the browser's search URL before reading it

- **What happened:** The catalog browser test failed an unrelated merge-group run because `q` was still `null` immediately after filling the search field (#3066).
- **Root cause:** The catalog writes the query synchronously with `history.replaceState`, but Playwright's cached page URL can lag behind the browser's same-document navigation. The test read that cache before awaiting the expected URL.
- **Error class:** Reading browser navigation state before its notification reaches the test process.
- **Guard:** The catalog browser test awaits the exact URL query after search and reset, preserves the original assertions, and checks search restoration after reload and same-document Back at desktop and phone widths. The `test-waits` and `settle-reads` checks guard condition-based waits and settled geometry reads.
