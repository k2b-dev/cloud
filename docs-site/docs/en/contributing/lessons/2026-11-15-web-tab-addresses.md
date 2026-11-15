### Web tabs use the same address rule throughout their lifecycle

- **What happened:** Web tab creation and persistence accepted addresses that restoration did not support.
- **Root cause:** The address rule lived only in URL restoration.
- **Error class:** Inconsistent input validation across lifecycle boundaries.
- **Guard:** Workspace state, controller, and storage tests cover the same supported address protocols.
