### Busy rollups used an unfenced retry path after recovery

- **What happened:** Merging maintenance admission with checkpoint recovery left busy rollups on a retry path without a fence.
- **Root cause:** The busy branch preceded the recovery transaction, and checkpoint admission could fail before an hour was claimed.
- **Error class:** Stale background writes and retry-budget exhaustion during ordinary contention.
- **Guard:** Test: recovery integration tests check busy checkpoint admission and both failure paths across unchanged, revised, reset and blocked hours; every backoff update uses the same writable-state, revision and generation checks.
