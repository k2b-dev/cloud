### SDK changes must cover isolated hosts and CI-only fixtures

- **What happened:** Code SDK smoothing passed focused local checks but failed isolated runner and integration tests in CI.
- **Root cause:** CI-only fixtures still used the old visitor, schedule and error contracts. The runner host also omitted structured error fields when its bridge transport failed.
- **Error class:** Public contract drift across execution boundaries.
- **Guard:** The production-host adapter tests in `packages/runner/test/host.test.ts` cover transport failures and preserve distinct refusal statuses. The image and hostile-runner tests exercise the current visitor projection and assert refusal codes while retaining their size and concurrency limits; integration tests assert both transport and SDK error statuses explicitly.
