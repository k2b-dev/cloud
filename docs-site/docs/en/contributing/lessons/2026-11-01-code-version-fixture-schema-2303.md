### Build version fixtures against the current identity schema

- **What happened:** Code-version integration tests stopped at a removed service-account column. After correcting it, tests exposed a missing session migration, an attempted update to immutable ownership, an SQL result comparison mismatch and cleanup after its database had already been dropped.
- **Root cause:** The fixture reproduced an older identity schema and ownership lifecycle. Its private database was dropped by a suite hook before an imported session fixture's file-level cleanup ran.
- **Error class:** Integration fixture schema and lifecycle drift after shared contracts change.
- **Guard:** Store scopes on credentials, apply the migrations used by recent browser confirmation, and create resource-owned Code through its service. Compare the complete rejection audit metadata as a plain array. Keep the private database alive through session-fixture cleanup. The complete version integration file exercises all these boundaries, including its teardown hooks.
