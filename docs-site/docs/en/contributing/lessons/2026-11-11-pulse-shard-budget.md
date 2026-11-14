### A shard deadline looked like a page lifecycle race

- **What happened:** Pulse's store page reported `addScriptTag: Target page, context or browser has been closed` during run 43107491675 (#3189).
- **Root cause:** Immediately before that error, the runner logged "Time budget exhausted" and stopped the shard's descendants. Stale Core, Files and Pulse weights assigned more work to the shard than its unchanged twenty-minute budget allowed; the page was closed by the runner, not by a competing test variant.
- **Error class:** A scheduler's stale cost model overbooks a shard, and a forced shutdown is misdiagnosed as a failure in the code running at the deadline.
- **Guard:** The unit matrix uses ten shards and preserves prior maxima while incorporating completed measurements from runs 43107491675 and 43081417410, including successful suites from failed jobs. `run-tests.test.ts` checks every actual unit shard against the incident's completed Core, Files and Pulse timings and the existing fifteen-minute planning target. A single-file reproduction under a 50% CPU quota confirms the runner's budget shutdown; the store browser cases run separately under the same quota.
