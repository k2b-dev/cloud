### Cached authorization must not consume remote-call traversal budgets

- **What happened:** Cold system chats could fail snapshots, hide later directory threads and lose search results beyond the eighth container. One broken item could also block its container’s discovery page.
- **Root cause:** Candidate SQL limits reused a remote-call counter across nested reads; item failures escaped the collection boundary, and search reread containers concurrently.
- **Error class:** Coupled traversal and transport budgets with collection-wide failure propagation.
- **Guard:** `generic-discussions.integration.test.ts` covers cold 61-thread snapshots, directory continuation, isolated reader failures and cold search across twelve containers. `resource-access.test.ts` checks free cache hits, in-flight deduplication, optional open links and constrained icons. Cursor contract tests and `chat-app-ids.test.ts` guard the input and source boundaries.
