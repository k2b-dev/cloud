### Folder syncs starve Mail commands on busy mailboxes

- **What happened:** Moves, folder creation, and sends stayed queued for minutes while hundreds of folders kept syncing ([#1268](https://github.com/k2b-dev/cloud/issues/1268)).
- **Root cause:** Head starts ordered individual waiters, so every older folder sync went before a command. Retained places and continuous syncs made that wait grow with the folder count.
- **Error class:** Lease starvation under a continuous competing workload.
- **Guard:** Commands and other provider work alternate in the lease line. `provider-lease-fairness.integration.test.ts` checks continuous syncs of many folders through the command worker, both directional turn bounds, and a seeded mixed sequence with exactly one first waiter. Existing continuation, body-batch, and bulk-move tests preserve sync progress.
