### An unrelated rejected registry entry blocked offline app removal

- **What happened:** An offline app could not be removed while any other app had a rejected registry entry.
- **Root cause:** Both registry checks treated any issue in the snapshot as uncertainty about the target app.
- **Error class:** Applying aggregate failure state to an operation on one resource.
- **Guard:** `packages/core/src/app-listing.test.ts` checks unrelated rejected entries at both reads, rejects a target entry with `app_running`, and catches a rejected target entry appearing during provider effects.
