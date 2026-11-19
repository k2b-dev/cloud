### Core admitted resource Code without its application owner contract

- **What happened:** Code for an unsupported Space owner was created and activated, but every run exhausted its lease retries.
- **Root cause:** Core checked owner administration without requiring the local resource type in the owning application's `manifest.code.owners`. The signed owner route is mounted only for declared Code owners, so its title request returned 401.
- **Error class:** Creation bypasses a required provider lifecycle contract.
- **Guard:** `owner-registration.test.ts` refuses missing, empty and mismatched declarations before owner reads or persistence, preserves live administration checks and tests translated HTTP failures. The Core acceptance integration refuses real undeclared Space owners without creating Code or accounts, then exercises declared Mail owners through execution.
