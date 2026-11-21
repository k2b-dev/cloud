### Preserve workload authority when capability targets change

- **What happened:** Incoming Mail automations retained operation-only mandates after Spaces actions began requiring explicit targets.
- **Root cause:** Call transport changed without migrating the stored Mail workload authority or its policy builder.
- **Error class:** Persisted authorization and invocation contract drift.
- **Guard:** The incoming-automation integration tests reconstruct pre-upgrade policies without grants, verify a real Spaces event and refusal at another target, and cover visible recovery, transactional rollback, auditing, and a second migration with no changes.
