### Guard administrator writes at the owning declaration

- **What happened:** The new Tools settings route received focused review and additional write-boundary guards before landing.
- **Root cause:** Route ownership and request mapping need tests alongside the shared service's validation tests.
- **Contract:** Application settings routes accept only keys from their application's declared setting list and pass explicit values to the shared settings service.
- **Error class:** A route's accepted keys or request fields can drift from its owning declaration.
- **Guard:** Tools tests cover current administrator roles, OAuth scopes, declared keys, invalid values and server-owned audit attribution. Rejected input must not start a settings transaction or record a successful audit event.
- **Verification:** Run the focused administrator-settings tests and the affected repository rules on the final stacked head before pushing.
