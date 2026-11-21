### Repeated admission phases exceeded the Code call SQL budget

- **What happened:** One signed Code capability call executed 50 SQL statements, including transaction control.
- **Root cause:** Receipt admission, authority projection, issuance and completion repeated reads and opened separate transactions for work that could commit together.
- **Error class:** Fixed per-call SQL amplification across shared boundaries.
- **Guard:** The complete signed-call test in `packages/cloud/src/code/bridge.integration.test.ts` uses `meterSql()` to enforce at most 18 statements, alongside receipt visibility, revocation, expiry, concurrent ordering, transaction rollback and idempotent retry checks.
