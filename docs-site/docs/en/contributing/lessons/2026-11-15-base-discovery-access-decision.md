### Discovery and readers must share one access decision

- **What happened:** Base discovery and the base reader disagreed about which bases a caller could access.
- **Root cause:** Discovery included a principal tier that the base reader did not accept.
- **Error class:** Authorization drift between discovery and resource readers.
- **Guard:** `packages/grids/src/service/bases.integration.test.ts` checks that discovery excludes unsupported grants from both results and totals for each subject type while preserving supported access. Keep discovery aligned with the reader before pagination and projection.
