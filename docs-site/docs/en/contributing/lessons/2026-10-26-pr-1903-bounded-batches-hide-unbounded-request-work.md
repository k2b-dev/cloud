### Bounded batches hide unbounded request work

- **What happened:** A reader limits concurrency but traverses every item or repeats nested scans for each container.
- **Root cause:** Bounded batches hide unbounded request work.
- **Error class:** Bounded batches hide unbounded request work
- **Guard:** Tests: Chat `system-chats.integration.test.ts` asserts total reader calls for selected histories, shared summary budgets, and fully hidden read-all pages, including continuation.
