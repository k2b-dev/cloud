### Observe the accepted cleanup run instead of the latest completion

- **What happened:** The shared link-retention integration test timed out at an hour boundary even though its manual cleanup had removed the expired link.
- **Root cause:** Sync's `awaitRun()` polls one latest-completion record. The next hourly run can replace the manual run's completion before the test observes it. A deterministic successor run reproduced the same `{ completed: false }` result after successful cleanup. The underlying Sync completion-history defect, operator status route, and other callers are tracked in [k2b-dev/sync#10](https://github.com/k2b-dev/sync/issues/10).
- **Error class:** A replaceable latest-state snapshot used as historical completion evidence.
- **Guard:** `packages/cloud/src/services/links/runtime.integration.test.ts` records run-specific settlements from both Core replicas, asserts exactly one success for the deduplicated manual run, checks deletion before a successor runs, and rechecks the original settlement after the successor completes. Its existing registration and ownership assertions remain, and its completion wait stays bounded at ten seconds.
