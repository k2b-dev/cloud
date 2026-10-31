### Resolve native SQL handles when the operation runs

- **What happened:** During the Grids client migration, unit imports failed before platform startup, and document services could retain a pool closed by a test database reset.
- **Root cause:** Module-level SQL fragments and the document service factory captured the current native SQL handle before the final platform target was selected.
- **Error class:** Captured client lifetime exceeds the initialized connection lifetime.
- **Guard:** `platform-clients.integration.test.ts` switches database targets after constructing services; offline compiler tests use `useUnitClients()` and construct SQL fragments inside tests, while route unit tests import services before startup.
