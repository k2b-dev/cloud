### Cold mailbox counts held Mail's first render for up to 30 seconds

- **What happened:** When the view counts of a mailbox were cold, Mail's page and every workspace snapshot waited for them: up to 30 seconds (`FILL_WAIT_MS`), or the page failed with "counts are refreshing". The list itself was ready long before.
- **Root cause:** The page, the Assigned-to-me groups and the done-footer read the cached counts with the cache's full fill wait. The counts are useful but not needed to show the list.
- **Error class:** A first render that waits on a derived, cacheable value without a budget of its own.
- **Guard:** The loaders wait for cold counts only `FIRST_RENDER_COUNT_WAIT_MS` (a tenth of the fill lease, 1 s). After that they render with `viewCountsPending`: the tabs show no number, the count goes on in the background, and the browser loads it once from the cache. Tests: `view-count-cache.integration.test.ts` (a held lease answers within the wait; the count goes on and fills the cache), `MailWorkspace.mailbox-switch.behavior.test.tsx` (pending counts load once), and `large-mailbox.integration.test.ts`, which pins a warm page load to a fixed statement count with `sql-meter`.
