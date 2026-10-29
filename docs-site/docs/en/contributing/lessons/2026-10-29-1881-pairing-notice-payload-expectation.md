### Pairing notice schema assertions must include administrator attribution

- **What happened:** PR #1881 failed the Core notification unit test because the expected payload fields omitted `pairedByName`.
- **Root cause:** Administrator-assisted pairing added an optional administrator name to the notification schema, but left the exact field assertion unchanged.
- **Error class:** A schema extension leaves a contract test expecting the previous payload.
- **Guard:** `packages/core/src/notifications.test.ts` keeps the exact field assertion and verifies self-pairing without attribution and administrator attribution in both notification formats, in German and English.
