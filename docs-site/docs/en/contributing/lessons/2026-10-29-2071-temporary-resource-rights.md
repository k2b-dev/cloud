### Keep temporary fixtures compatible with PostgreSQL

- **What happened:** The resource-derived app-access integration test failed before its first assertion because PostgreSQL rejected the fixture table.
- **Root cause:** A temporary resource-to-grant table declared a foreign key to the permanent `auth.access` table. PostgreSQL allows temporary tables to reference only other temporary tables.
- **Error class:** Integration fixture DDL violates the database's table-lifetime constraints.
- **Guard:** `services/app-access-resources.integration.test.ts` uses a temporary mapping without that foreign key. Its existing revocation assertions require the real permission query to reject deleted grants even while their mapping rows remain.
