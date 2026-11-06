### Authoring checks inherited the runtime process memory budget

- **What happened:** On a fresh installation, checking the unchanged `cld code init` template failed with `code_check_memory_limit`. Tests and simulations also failed during their source check.
- **Root cause:** Core capped the checker’s declared 512 MiB RSS budget with the default 128 MiB workerd process budget before sending the job to the runner. The compiler and bundler need their own authoring budget.
- **Error class:** An authoring tool’s limit derived from a runtime budget.
- **Guard:** `packages/core/src/code/runner-jobs.test.ts` checks independence from the minimum, default and maximum runtime process budgets. `packages/cloud/src/code/checker.test.ts` checks the init template with the real compiler and default Core job limits. `packages/core/src/code/scheduling.integration.test.ts` checks the actual init output through queued checks for check, test and simulation hosts. `packages/runner/test/runner.test.ts` verifies that the checker role receives Core’s limit unchanged.
