### Sync history retained empty work and cleanup could fall behind

- **What happened:** A reported installation estimated 9.13 million Mail sync runs and 19.5 GB of relation storage. Full empty batches still accumulated history even after quiet CONDSTORE checks learned to skip writes.
- **Root cause:** Completion history doubled as the sync-command progress checkpoint. The age/order index existed only in fresh-install SQL, auxiliary cleanup shared the same transaction and five-second budget, and generic delete joins could still scan the entire heap after indexed candidate selection.
- **Error class:** Unbounded growth of runtime history.
- **Guard:** `sync-recovery.integration.test.ts` requires empty full commits and awaited syncs to retain no history while preserving progress through one folder checkpoint. `runtime-history-retention.integration.test.ts` verifies three-day success/thirty-day error retention, a 40,001-row backlog in independently committed batches, lock skipping, auxiliary failure and statement-budget isolation, background upgrade indexes, and generic index/TID plans without heap scans or sorting.
