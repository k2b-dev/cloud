### The WebKit plan stood at its target, so one new test file stopped the queue

- **What happened:** The merge group of #4287 failed in `unit (12)` and `integration (6)` on "CI webkit shards cover the selection exactly once and fit the measured budget". #4287 added one WebKit test file, and the plan of 22 shards went over the 11-minute target.
- **Root cause:** The committed WebKit weights dated from two runs and 514 files. With 577 files, the plan on main already needed 10.99 of its 11 minutes, so the median weight of one more file was enough. Measured in ten current merge-group runs, the 22 shards need 12.3 minutes.
- **Error class:** Shard weights that are not refreshed while files are added, until one more file fails a pull request that is not the cause. This is the class #4404 fixes for the unit shards.
- **Guard:** None new. The existing plan test in `scripts/run-tests.test.ts` caught the overrun before any WebKit job ran out of time. Refresh the browser table with `bun scripts/test-weights.ts --run <ids> --mode browser` when a shard warns that it is above its target, and leave room for more files.
