### A shared settings cache hid a table the test database never had

- **What happened:** `file-capabilities.integration.test.ts` failed once in CI with `relation "settings.entries" does not exist` on a pull request that did not touch Files. Most other runs passed the same test.
- **Root cause:** `entry.read` reads `app.timezone` through `coreSettings.get`. That read asks the Valkey cache first and goes to Postgres only on a miss. All integration processes share one Valkey, but each Files suite has its own private database, and this suite created only the `filesv2` tables. When another suite had cached `app.timezone` in the last five minutes, the read never reached Postgres and the test passed. When nothing had, it read the private database and failed.
- **Error class:** An integration test whose private database lacks a schema that a real code path reads, hidden by a cache that other test processes fill.
- **Guard:** The suite runs the real settings migration and makes `requestCacheRedis` reject, so every settings read in the file reaches its own database on every run. Without the migration, the test fails whether the shared key is set or not.
