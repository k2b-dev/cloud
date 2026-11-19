### Stale unit weights hide a suite that exceeds the shard target

- **What happened:** After sync 62 on `feat/code`, unit shard 4 took 17.1 minutes in green CI run 44443688140, leaving little room below its unchanged 20-minute execution budget.
- **Root cause:** The `@k2b/cloud ssr-ai` suite was weighted at 699.3 seconds but completed in 981.8 seconds. The planner therefore grouped it with four other suites. Refreshing the weights moves it to a shard alone, but its 16.36 minutes still exceed the 15-minute unit target; weights alone cannot split a suite.
- **Error class:** Stale timing measurements conceal an indivisible workload above its planning target.
- **Guard:** `shardTimeNotice` warns above the target before the deadline fails. The existing `scripts/run-tests.test.ts` check requires every predicted unit shard to fit 15 minutes and rejects the refreshed plan until the oversized suite is split or made faster. Refresh weights when the warning appears; keep the execution budget unchanged.
