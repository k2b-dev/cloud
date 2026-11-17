### The Mail integration suite filled a shard on its own and stopped at the budget

- **What happened:** The main merge queue ejected #3572 with `Time budget exhausted during @k2b/cloud-app-mail` in `integration (1)` ([#2055](https://github.com/k2b-dev/cloud/issues/2055)). In seven other runs on the same day, that shard took 14.4 to 19.1 minutes, while the other four integration shards took 8.5 to 13.1 minutes.
- **Root cause:** Mail owns its integration script, so the runner ran all 124 Mail files as one suite. That suite took 852 to 1183 seconds, but its weight of 816 seconds still put it alone in one shard. The planner cannot split a suite, so more shards could not help.
- **Error class:** A CI shard grows toward its job limit.
- **Guard:** A package can list the files of its own integration script with `test:integration:list`. The runner then runs each file through that script as its own suite, and Mail does this. The weights hold Mail's per-file times, and CI has six integration shards: each is predicted at 11.8 minutes. The runner test fails when a predicted integration shard exceeds 15 minutes, or when a single integration suite is weighted above 10 minutes.
