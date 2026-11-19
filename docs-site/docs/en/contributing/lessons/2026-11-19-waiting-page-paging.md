### Waiting entries beyond the first page must remain reachable

- **What happened:** With twenty open approvals and a newer Code version, the sidebar counted 21 but the waiting page offered no way to reach the version.
- **Root cause:** The shared feed and Code sources retained only the twenty oldest entries, and the page filtered versions from that first page without a continuation.
- **Error class:** A total count was paired with a truncated list that had no reachable continuation.
- **Guard:** `AssistantWorkspace.waiting.behavior.test.tsx` covers twenty approvals plus a newer version, paging failure and retry while retaining existing cards. `open-questions.test.ts`, `open-questions.integration.test.ts` and `review-chat.integration.test.ts` cover bounded pages, timestamp ties, terminal cursors, resolved cursor entries and Code sources beyond twenty.
