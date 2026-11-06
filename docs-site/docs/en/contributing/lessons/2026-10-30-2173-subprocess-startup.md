### Subprocesses need one startup owner after selecting their transport

- **What happened:** Grids children failed before migrations when they inherited an initializer. Identity benchmark processes skipped initialization, bypassed seeded settings caches, and measured extra database reads.
- **Root cause:** The integration runner propagates its preload through `BUN_OPTIONS`, while the benchmark starts outside that runner. Neither path accounted for who owned startup after selecting its final transport.
- **Error class:** Missing or duplicate process initialization.
- **Guard:** `scripts/fixtures/platform.test.ts`, `packages/grids/scripts/verify-start.integration.test.ts`, both Grids crash integration files, and `packages/core/scripts/bench-platform-start.test.ts` exercise subprocess startup. `packages/cloud/src/services/settings/startup.test.ts` prevents settings fallback from hiding missing initialization.
