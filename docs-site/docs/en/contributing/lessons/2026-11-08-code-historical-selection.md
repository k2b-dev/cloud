### Historical selections need their own admission checks

- **What happened:** Catch-up could select existing messages but could not admit their runs.
- **Root cause:** Historical processing reused a live-delivery prerequisite that a saved selection does not have.
- **Error class:** Reusing lifecycle prerequisites across distinct entry paths.
- **Guard:** `packages/cloud/src/code/event-catchup.integration.test.ts` exercises the real Mail receipt resolver and reader with a saved operation, checks one admission across repeated selection, and verifies that catch-up creates no broadcast records.
