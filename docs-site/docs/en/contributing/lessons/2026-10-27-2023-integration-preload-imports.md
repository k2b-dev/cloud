### Integration helpers leaked into CLI host startup

- **What happened:** CLI host commands loaded `scripts/workspace.ts` through the shared test preload, failing the module isolation guard in #2023.
- **Root cause:** The infrastructure gate imported the migrated database template statically for database name validation and cleanup, bringing workspace discovery into every unit test subprocess.
- **Error class:** A shared preload eagerly imports dependencies used only by integration fixtures.
- **Guard:** The gate imports template code only when a migrated database is requested. Name validation stays in the pure environment helper, and cleanup runs only if template code was loaded. `test-infra-env.test.ts` checks that preloading with or without a database target loads neither template nor workspace code; `packages/cloud-cli/src/modules.test.ts` retains its host module isolation assertion.
