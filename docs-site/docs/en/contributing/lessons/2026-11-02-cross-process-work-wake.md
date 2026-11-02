### Idle dispatchers poll too often while wake signals stay inside one process

- **What happened:** Idle outboxes, workflow workers, and Core event delivery queried Postgres every second. Outbox notifications woke only their own process.
- **Root cause:** A one-second recovery timer also served as normal work discovery. Core discarded hints received during an active pass and tied minute maintenance to pass count.
- **Error class:** Polling replaces distributed wake signals; concurrent hints are lost; maintenance depends on traffic volume.
- **Guard:** `idle-workers.test.ts` advances a frozen minute and counts twelve safety scans per dispatcher, with separate workflow slot counts. `outbox.integration.test.ts` commits and signals from another OS process. `app-events/runtime.test.ts` checks coalescing, backlog draining, shutdown, and failure recovery.
