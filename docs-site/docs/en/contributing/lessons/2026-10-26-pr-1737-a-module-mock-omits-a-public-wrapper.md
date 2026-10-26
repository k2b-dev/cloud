### A module mock omits a public wrapper

- **What happened:** A socket fixture replaces the whole server module but drops an export used by the real route, so import fails before the intended assertions run.
- **Root cause:** The whole-module server mock omitted an export imported by the actual socket route.
- **Error class:** A module mock omits a public wrapper
- **Guard:** Tests: Notebooks `ws-lineage.test.ts` and `ws-awareness.test.ts` keep the socket access wrapper in their isolated server mocks and exercise the real route handlers. Preserve the wrapper's event-return contract in fixtures.
