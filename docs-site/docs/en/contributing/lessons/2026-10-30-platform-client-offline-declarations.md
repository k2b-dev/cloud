### Keep SQL fragment construction out of offline declarations

- **What happened:** The platform-client migration made capability checks fail with `sql used before platform start` when loading an application declaration.
- **Root cause:** `createPgOutbox()` built native SQL identifier fragments during declaration. The platform SQL handle requires startup, while capability checks and build discovery load declarations offline.
- **Error class:** Import-time access to startup-owned dependencies.
- **Guard:** `packages/cloud/src/services/outbox.test.ts` checks that a valid outbox can be declared and stopped before startup, and that identifier validation still rejects unsafe names immediately. The `capability-presentation` check loads real application capability declarations offline.
