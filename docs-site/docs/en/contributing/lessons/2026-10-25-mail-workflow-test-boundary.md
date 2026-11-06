### Mail workflow tests belong outside application source

- **What happened:** The repository check rejected four private Cloud imports in Mail's workflow integration test.
- **Root cause:** A test that drives platform internals lived in application source, where only public Cloud imports are allowed.
- **Error class:** Test code crosses the application source boundary.
- **Guard:** The `boundaries` check continues to reject private platform imports from application source. The integration test lives in `packages/cloud/test/integration/`, where it can exercise private platform internals. It keeps Mail's disposable database and Sync setup. `scripts/run-tests.test.ts` explicitly requires the file in the isolated integration suites used by CI.
