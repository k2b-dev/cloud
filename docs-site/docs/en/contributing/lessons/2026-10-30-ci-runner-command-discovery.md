### Keep CI runner commands discoverable when adding diagnostics

- **What happened:** Adding a storage sampler around the CI integration command made the shard coverage and budget guard fail with `integration job needs its test runner command`.
- **Root cause:** The workflow step no longer began with `bun run test `, which `scripts/run-tests.test.ts` uses to discover and validate the real CI runner command.
- **Error class:** Diagnostic wrappers can break a workflow contract consumed by repository guards.
- **Guard:** The existing `CI integration shards cover the selection exactly once and fit the measured budget` test. Keep the runner command in its own step and put diagnostic setup and cleanup in separate steps; run `bun --no-env-file test scripts/run-tests.test.ts` when changing these steps.
