### Index both branches of a bulk-delete trigger lookup

- **What happened:** Deleting 10,000 message links through Mail's thread-rebuild repair spent extra time checking which shared draft rooms lost access.
- **Root cause:** The row trigger searched drafts by source or derived message ID. The source index and mailbox-leading derived index did not provide two selective paths for open shared drafts. PostgreSQL scanned the document-coverage index and filtered its shared drafts for every deleted link.
- **Error class:** A row trigger repeats a lookup whose indexes do not match its full predicate.
- **Guard:** `room-access-bulk.integration.test.ts` deletes 10,000 links through `executeOperatorAction`, pins nine client statements with `meterSql()`, and requires indexed source and derived lookups with `EXPLAIN (ANALYZE, BUFFERS)`. The plan assertion covers trigger work that the client SQL meter cannot count. Migration tests verify both partial indexes, upgrade creation outside a transaction, and idempotent reruns. Room-access tests verify coalesced mailbox hints for source and derived drafts, including cascades and unrelated private or closed drafts.
