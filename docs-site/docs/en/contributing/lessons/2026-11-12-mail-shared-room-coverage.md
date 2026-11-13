### Covered log pruning must preserve active collaboration bases

- **What happened:** A connected editor could require recovery after a snapshot pruned the log prefix that its room still needed for admission.
- **Root cause:** The room retained its join-time SQL base while delivering newer retained updates. Once a covering snapshot pruned those updates, rebuilding admission from that old base encountered missing history.
- **Error class:** Disposable connection state lagging durable coverage.
- **Guard:** `packages/cloud/src/shared-text/room.test.ts` admits another update after advancing and pruning covered history. The two-node Mail harness also checks final convergence against flushed SQL snapshots.
