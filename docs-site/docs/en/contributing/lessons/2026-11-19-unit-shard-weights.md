### Stale unit weights hide a suite that exceeds the shard target

- **What happened:** After sync 62 on `feat/code`, unit shard 4 took 17.1 minutes in green CI run 44443688140, leaving little room below its unchanged 20-minute execution budget.
- **Root cause:** The `@k2b/cloud ssr-ai` suite was weighted at 699.3 seconds but completed in 981.8 seconds. The planner therefore grouped it with four other suites. Even alone, its 16.36 minutes exceeded the 15-minute unit target. Separate `ssr` and `ai` parts now let the planner distribute that workload; their initial weights come from the same run's completed file groups and process overhead.
- **Error class:** Stale timing measurements conceal an indivisible workload above its planning target.
- **Guard:** `shardTimeNotice` warns above the target before the deadline fails. The existing `scripts/run-tests.test.ts` checks require every predicted unit shard to fit 15 minutes and verify that the rest part excludes exactly the directories selected by the other parts. They pass with the separate SSR and AI parts and refreshed weights. Refresh weights when the warning appears; keep the execution budget unchanged.
