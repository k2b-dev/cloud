### A busy mailbox lease sat idle and every wait cost a database read

- **What happened:** The folder jobs of one mailbox wait in line for its provider lease. Each job read its folder from Postgres before it asked for the lease, so each refused attempt cost one statement. In production that was about 1,400 a minute. Waiters asked again only every one to four seconds, so after a release the lease often stayed free until the next in line came back. A simulated mailbox with 100 folders and 300 ms batches served 47 batches a minute instead of about 200.
- **Root cause:** The folder read was only there to find the lease's resource, and the retry pace grew in one-second steps. The waiter next in turn was often still asleep when its turn came.
- **Error class:** Polling a shared lock with a backoff coarser than the work it waits for, and doing paid work before the lock check.
- **Guard:**
  - `sync-recovery.integration.test.ts` ("a folder job's turn that finds the lease busy runs no database statement") requires one statement in the first turn and none in later busy turns, which carry the remote mailbox in their input.
  - `provider-lease-fairness.integration.test.ts` ("the next in line asks again within a quarter second, so a released lease does not sit idle") pins the 250 ms steps per place.
  - The rest of the fairness file keeps the turn order: sync before background, commands between syncs.
