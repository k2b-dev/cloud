### Isolated server tests must provide their platform dependencies

- **What happened:** API and browser tests failed after switching Cloud services to the platform SQL and Redis handles. SSR fallback paths returned 500 instead of the expected page.
- **Root cause:** API tests still intercepted Bun's global Redis client, while middleware used the platform client. Layout harnesses left Help reads active without Sync startup, and their warning logs reached an uninitialized SQL handle. An admin error-path test also left its logging service active.
- **Error class:** Test fixtures bypassing dependency initialization or intercepting the wrong client.
- **Guard:** API tests opt into `useUnitClients()` and spy on the platform Redis handle. Layout harnesses stub the Help preload, and the admin fallback test stubs and asserts its error log. Help preload unit tests use the native unit clients. Run these files in isolation so another suite cannot supply missing startup or mocks.
