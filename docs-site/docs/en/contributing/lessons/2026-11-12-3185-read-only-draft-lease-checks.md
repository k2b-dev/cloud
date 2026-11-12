### Concurrent attachment preparations exhausted the lease-state mutex

- **What happened:** Parallel FileRef attachment imports into a free draft failed with a transient lease-busy response before any bytes were transferred.
- **Root cause:** The availability check took the same exclusive state mutex as lease changes. More simultaneous readers than its bounded retry budget could therefore refuse each other even without an editor holding the draft.
- **Error class:** Read-only checks unnecessarily contend on mutation locks.
- **Guard:** `draft-lease-availability.test.ts` checks concurrent free-draft readers, held and revoked holders, permission denial, visible failures and continued serialization of state-changing lease operations. The unchanged slow-writer integration test exercises parallel imports beyond the database pool size. New capability Actions also run the presentation, provider inventory and owning policy-contract test files.
