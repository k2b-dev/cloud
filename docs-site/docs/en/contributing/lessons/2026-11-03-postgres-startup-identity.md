### Pooler parameter restoration can look like application SQL

- **What happened:** A near-idle production measurement after release 0.63 recorded 976 `SET application_name` calls per minute and suggested moving application names to connection startup.
- **Root cause:** Cloud already sends the name in Bun's native startup parameters. A wire-level test confirms zero application-issued SETs. PgBouncer's parameter cache restores differing client application names when reassigning a server connection in transaction pooling; startup parameters do not eliminate those server-side SETs. Attribution of the exact production count still needs pooler-side measurement.
- **Error class:** Attributing infrastructure-generated SQL to application transaction code.
- **Guard:** `runtime/clients-protocol.test.ts` counts one startup name and zero SET statements over 20 transactions, separately for the default name, operator URL name and explicit connection override.
