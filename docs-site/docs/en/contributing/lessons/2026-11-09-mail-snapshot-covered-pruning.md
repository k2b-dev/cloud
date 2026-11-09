### Retain draft edits until durable snapshots cover them

- **What happened:** The prepared shared-draft log could evict accepted edits by age or byte pressure before SQL stored them.
- **Root cause:** Discard-old retention was independent of application-owned snapshot coverage.
- **Error class:** Retained-log truncation crosses an external durability boundary.
- **Guard:** Mail's real NATS/Postgres retention integration tests cover rejection without eviction, retry after pruning, missing snapshots, idle proofs, advisory-lock races, restart, policy migration and interrupted cutover. Pruning uses the minimum committed coverage and excludes writes while computing that watermark.
