### Distinguish tenant delivery from the global retention window

- **What happened:** Pruning safely persisted events for one document closed an idle editor of another document with `RESYNC_REQUIRED`; a stale reconnect cursor also closed despite a covering stored snapshot.
- **Root cause:** Sync checked the global retained window before advancing a caught-up tenant consumer's proof. The room treated every replay gap as terminal instead of rebasing from a covering snapshot.
- **Error class:** A global retention watermark is mistaken for evidence of missing tenant input.
- **Guard:** Sync's `topic-idle-prune.test.ts` exercises the interleaved prune and a real own-tenant gap. Cloud's `room-prune.integration.test.ts` covers idle pruning, a covered reconnect and an uncovered gap on real NATS; `room.test.ts` guards both reader and writer rebases.
