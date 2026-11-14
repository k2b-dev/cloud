### A fitting shard matrix still needs room for new test files

- **What happened:** Adding one browser test file in #2810 pushed a WebKit shard to 660.45 seconds, failing the 660-second planning guard and blocking the merge queue.
- **Root cause:** The fifteen-shard plan selected in #2804 predicted 10.97 minutes against an 11-minute target, leaving almost no room for new files. Refreshing browser weights from four completed runs, including failed and budget-aborted jobs, requires seventeen shards; sixteen still predict 660.4 seconds. Seventeen predict 621.5 seconds, leaving 38.5 seconds of headroom.
- **Error class:** Capacity planning at a hard limit without room for workload growth.
- **Guard:** The existing `scripts/run-tests.test.ts` test `CI webkit shards cover the selection exactly once and fit the measured budget` enforces exact coverage and the 11-minute target. No further automated guard is needed: it caught this regression, while the matrix now leaves measured growth headroom. Replaying ten extra unmeasured files at the current median still fits at 628.9 seconds; future weight refreshes must reconsider that headroom.
