### Application declarations outlive the client selected during import

- **What happened:** Moving native clients behind platform startup exposed module-level SQL fragments, an eagerly constructed owned pool, and background factories that retained the pre-start client instead of the running installation's client.
- **Root cause:** Module evaluation and singleton construction happened before platform initialization, while SQL fragments and factory defaults captured the client they first observed.
- **Error class:** A declaration captures a dependency before its lifecycle begins.
- **Guard:** `scripts/fixtures/platform-app-imports.test.ts` imports the remaining application data declarations without startup; `packages/pulse/src/service/platform-clients.test.ts` verifies a pre-start factory against successive client bindings; focused integration files select private databases before importing domain code. Create owned pools after startup and resolve default clients inside each operation.
