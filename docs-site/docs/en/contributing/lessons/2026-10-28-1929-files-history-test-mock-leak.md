### History authorization doubles leaked into later service tests

- **What happened:** Three history service tests failed when the authorization tests ran first: activity was empty, unreadable configuration resolved, and administrator base listing was missing.
- **Root cause:** The authorization fixture replaced service modules with `mock.module()`. Those replacements persisted across test files, so later fixtures composed a partial fake reader instead of the real reader. The merge resolution preserved the production reader correctly.
- **Error class:** Test module mocks leaking across test files.
- **Guard:** The authorization fixture uses per-test spies restored in `afterEach`. Running `bun test ./src/service/activity-authorization.test.ts ./src/service/activity-reader-service.test.ts` inside `packages/filesv2` exercises the previously failing order without file isolation and retains every authorization assertion.
