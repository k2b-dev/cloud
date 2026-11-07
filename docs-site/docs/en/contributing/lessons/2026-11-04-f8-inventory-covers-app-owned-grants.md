### The pre-switch inventory for "all signed-in people" listed built-in apps only

- **What happened:** The operator note for the change of the `authenticated` tier came with a read-only inventory of agents and service accounts that lose access. It listed the link tables of the built-in apps by name. A third-party app that links its own resources to `auth.access`, such as a workspace table, was not covered, although its machines lose the same access after it upgrades `@k2b/cloud`.
- **Root cause:** The inventory treated the list of link tables as fixed knowledge instead of reading it from the database, where every link table references `auth.access` with a foreign key.
- **Error class:** A platform-wide migration check enumerates the built-in consumers by hand and misses consumers that only the deployed database knows.
- **Guard:** The inventory now finds link tables through their foreign keys to `auth.access` and lists grants for all signed-in people that no table links. `signed-in-people-inventory.integration.test.ts` creates an app-owned link table and an unlinked grant and fails if either is missing from the result.
