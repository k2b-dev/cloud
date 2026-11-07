### A failed resource event held later messages indefinitely

- **What happened:** Resource-bound event delivery inherited subject-only ordering and held later delivery behind terminal failures. Code runs also grouped by message subject, allowing different messages to overlap.
- **Root cause:** Delivery ordering and run ordering used different partitions for a resource-owned handler.
- **Error class:** Inconsistent queue partitions and terminal failure release.
- **Guard:** `packages/core/src/code/events.integration.test.ts` checks different-message ordering, bounded retries, visible failure release and deliberate replay through the generic resource delivery seam.
