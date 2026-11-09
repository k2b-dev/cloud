### Retain draft edits until durable snapshots cover them

- **What happened:** The prepared shared-draft log could evict accepted edits by age or byte pressure before SQL stored them.
- **Root cause:** Discard-old retention was independent of application-owned snapshot coverage.
- **Error class:** Retained-log truncation crosses an external durability boundary.
- **Guard:** Mail's real NATS/Postgres retention tests (`draft-document-retention.integration.test.ts`) cover rejection without eviction, retry after pruning, missing snapshots, idle proofs, advisory-lock races, restart and recovery marking behind an expired prefix. `sync-budget.integration.test.ts` covers the in-place change of an old stream with its sequences kept. Pruning uses the minimum committed coverage and excludes writes while it computes that watermark.
