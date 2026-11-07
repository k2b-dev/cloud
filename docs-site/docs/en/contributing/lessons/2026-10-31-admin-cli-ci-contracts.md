### Check existing contracts when adding administration commands

- **What happened:** The admin CLI change passed its new focused tests but failed CI on existing API descriptions, CLI help, embedded skill files, scope expectations, and Pulse target removal.
- **Root cause:** Local verification missed existing consumer tests, including the served-plugin installer's explicit list of embedded skill references. Pulse returned a SQL result array through a transaction and then read its driver metadata, which was no longer present.
- **Error class:** A new administrative surface changes a consumer contract without checking its existing boundary tests; SQL result metadata escapes its transaction.
- **Guard:** Chat OpenAPI, Spaces reactions, app help, skill equality, served-plugin installation, Files configuration, and internal Sync tests cover those contracts. The Pulse internal-target integration test checks successful removal, its audit, and a second removal returning `NOT_FOUND`. Return the affected row count from inside the transaction.
