### Successful background checks accumulated a trace for every run

- **What happened:** Background trace storage grew to tens of gigabytes while successful runs repeatedly inserted and updated spans.
- **Root cause:** The Sync observer persisted lifecycle starts before knowing whether a run had any diagnostic value.
- **Error class:** Per-execution diagnostics turn routine background activity into unbounded storage and write load.
- **Guard:** `problem-runs.integration.test.ts` runs 1,000 successful jobs and uses SQL triggers to assert zero span writes and one minute upsert; it also checks failures, retries, slow runs and size retention. `run-rollups.test.ts` checks exact count, sum, maximum and minute identity without timing assertions.
