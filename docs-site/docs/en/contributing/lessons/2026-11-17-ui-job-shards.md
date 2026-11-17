### A green UI test suite exhausted the job's shared deadline

- **What happened:** The UI job reached its 30-minute limit after all tests passed in [#3649](https://github.com/k2b-dev/cloud/pull/3649); three other green runs took 22–29 minutes ([#3654](https://github.com/k2b-dev/cloud/issues/3654)).
- **Root cause:** One job ran the build, typecheck, the entire UI suite, and both fixture checks sequentially. The tests alone took up to 1,699 seconds, leaving almost no time for setup and the remaining checks.
- **Error class:** A growing test suite exhausts a shared job deadline despite passing tests.
- **Guard:** The existing measured shard planner now runs UI test parts in three shards with the runner's 20-minute budget and 15-minute warning target. `scripts/run-tests.test.ts` checks the UI matrix's measured headroom, every package-test and behavior file's assignment exactly once, and the packed-consumer check. `scripts/checks/ci-gate.test.ts` checks that both the UI shards and fixture job share the UI path filter and block the gate on failure.
