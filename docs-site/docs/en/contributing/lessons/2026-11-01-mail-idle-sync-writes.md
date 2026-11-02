### Idle folder checks rewrote unchanged metadata

- **What happened:** Every successful folder check rewrote its folder cursor, provider UID state, connection error state and mailbox health even when none changed.
- **Root cause:** Unconditional metadata updates mixed state transitions with freshness and fencing writes.
- **Error class:** Write amplification from unchanged background state.
- **Guard:** The idle-commit integration test in `sync-recovery.integration.test.ts` counts executed PostgreSQL commands and row-triggered writes across a fence claim and commit, then across a warmed whole idle folder batch. It requires five row writes instead of nine and 24 commands for the whole batch, preserves freshness in both health and operator readers, exercises changed-state recovery, and rejects a stale credential revision. Resource fencing, binding last use and sync-run history remain durable.
