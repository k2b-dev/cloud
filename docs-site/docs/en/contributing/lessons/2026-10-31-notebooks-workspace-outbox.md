### Workspace updates must survive a failed broker publication

- **What happened:** A saved note could leave open read-only notes and sidebars stale until another event or a reload.
- **Root cause:** Notebooks committed domain changes before publishing workspace hints, and the publisher only logged failures. No durable record remained to retry.
- **Error class:** An effect published after commit without an outbox is lost on broker failure or a process crash.
- **Guard:** `packages/notebooks/src/service/workspace-outbox.integration.test.ts` checks retry without another write, startup recovery, lost acknowledgement deduplication, transaction rollback, and reference projections before socket delivery. Workspace hint helpers require a transaction handle.
