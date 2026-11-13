### Distinguish tenant delivery from the global retention window

- **What happened:** Pruning safely persisted events for one document closed an idle editor of another document with `RESYNC_REQUIRED`; a stale reconnect cursor also closed despite a covering stored snapshot.
- **Root cause:** Sync checked the global retained window before advancing a caught-up tenant consumer's proof. The room treated every replay gap as terminal instead of rebasing from a covering snapshot. Uncovered gaps still need the adapter's repair before reconnect, while a live-hub gap must reconnect so a snapshot does not swallow a pending publish echo.
- **Error class:** A global retention watermark is mistaken for evidence of missing tenant input.
- **Guard:** Sync's `topic-idle-prune.test.ts` exercises the interleaved prune and a real own-tenant gap. Cloud's `room-prune.integration.test.ts` covers idle pruning, covered reconnects and recovery followed by a successful second join on real NATS. Room and Notebooks lifecycle tests guard recovery and one readiness frame; the browser provider test proves pending input is acknowledged after a hub-gap reconnect without `SYNC_TIMEOUT`.
