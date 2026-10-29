### A Mail automation log test looked for its entry only on the first page of a full day

- **What happened:** `Mail conversation automation log and undo > recovery keeps the original run day when the initial log projection was lost` in `packages/mail/src/service/automation-log.integration.test.ts` failed at random in merge groups with `Expected: true` and ejected unrelated pull requests (#2097).
- **Root cause:** All tests of the suite share one mailbox and run at the same frozen time. By this test, that day held 59 log entries with the same `created_at`. The list returns 50 per page, sorted by time and then by ID, so the restored entry's page depended on its random ID: locally it ranked 16th, 45th, or beyond the first page. The concurrent `recordMailWorkflowAudit` calls were not the cause; the entry was restored once and at the original time.
- **Error class:** A test asserts that an item is listed, but reads only the first page of a list that earlier tests filled with ties.
- **Guard:** The test reads every page of the day through `nextCursor` before it checks for the restored entry. It passed 5 of 5 runs locally; before, it failed 1 of 3.
