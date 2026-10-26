### A snapshot fixture retried saves until its test timed out

- **What happened:** The projections integration test timed out while its snapshot worker repeatedly rejected saves with a replay conflict ([#1651](https://github.com/k2b-dev/cloud/pull/1651)).
- **Root cause:** The anchored fixture inserted a shared cursor but left its sequence NULL. The save fence requires the stored sequence to be less than the incoming sequence; NULL cannot satisfy that comparison. Runtime writers persist both coordinates together.
- **Error class:** Incomplete stored-state fixtures.
- **Guard:** `yjs-snapshot-projections.integration.test.ts` initializes both coordinates and checks their persisted values before publishing, for both text-only initialization cases. It also asserts the real save result. Existing content, version, restore, and live-edit assertions and timeout bounds remain intact.
