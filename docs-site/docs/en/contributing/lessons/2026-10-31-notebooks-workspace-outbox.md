### Workspace updates must survive a failed broker publication

- **What happened:** A saved note could leave open read-only notes and sidebars stale until another event or a reload.
- **Root cause:** Notebooks committed domain changes before publishing workspace hints, and the publisher only logged failures. No durable record remained to retry. The first outbox implementation also omitted the wake after commit, delaying healthy delivery until reconciliation.
- **Error class:** An effect published after commit without an outbox is lost on broker failure or a process crash. An outbox without a wake delays delivery until its timer.
- **Guard:** `packages/notebooks/src/service/workspace-outbox.integration.test.ts` checks retry without another write, startup recovery, lost acknowledgement deduplication, transaction rollback, reference projections before socket delivery, and prompt socket delivery with a 60-second reconcile interval. Workspace hint helpers require a transaction handle; transaction owners use `workspaceTransaction()` to wake the dispatcher after commit. `workspace-transaction.test.ts` checks commit ordering, nonblocking delivery, and no wake after rollback.
