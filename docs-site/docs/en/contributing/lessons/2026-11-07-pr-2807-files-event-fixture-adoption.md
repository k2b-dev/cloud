### Upload event fixtures must prepare usable storage

- **What happened:** New Files event integration tests failed before reaching upload completion.
- **Root cause:** The fixtures created Cloud directories without adopting them as storage. A root-reader assertion also expected a permission error after changing the directory's owner, which first produces an ownership mismatch.
- **Error class:** Integration fixtures omit domain prerequisites or conflate distinct failure conditions.
- **Guard:** The event tests in `packages/filesv2/src/service/files.integration.test.ts` use the existing managed-upload adoption setup and assert ownership mismatch separately from an unreadable root with matching ownership.
