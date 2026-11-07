### Fence durable completion before draining a lost host

- **What happened:** Cancelling a managed host left its pending call marked `done` instead of `lost`.
- **Root cause:** Host teardown resolved approvals and awaited runner shutdown before marking running calls lost. The runner returns normally when stopped, letting the call completion handler commit during teardown. The Chromium transport had usually rejected instead, hiding that ordering dependency.
- **Error class:** Teardown unblocks asynchronous work before revoking its authority to persist completion.
- **Guard:** `closeSession()` marks running calls lost before resolving approvals or draining the host. Completion also checks that its session still owns the local slot. Teardown runs even if that database update fails. The server-owned lifecycle integration test requires a lost call with no stored result, then polls an interrupted durable call twice and verifies that no runner execution restarts.
