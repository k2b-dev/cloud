### Repair presentation must preserve the app callback boundary

- **What happened:** Reading app access during repair failed, and an edit could report failure after its transaction had committed.
- **Root cause:** Response presentation repeated the ordinary management check, invoking an app-owned callback that Core repair deliberately does not execute.
- **Error class:** Presentation reintroduces an authorization dependency excluded by the operation's ownership contract.
- **Guard:** `app-access-management.integration.test.ts` supplies throwing app callbacks during repair reads and edits. The same file verifies that ordinary edits reject removal or downgrade of the last eligible manager and preserve credential limits.
