### WebKit shard 1 hit its job limit and blocked the security release

- **What happened:** All 73 suites of WebKit shard 1 passed after 27.5 minutes of its test step. GitHub's job finalization during an Actions incident then pushed the job past its 30-minute limit, and it was cancelled in both the release PR run and a merge-queue run. Unit shard 3 took 28.8 minutes in the same run.
- **Root cause:** Round-robin by position put 27–29 minutes of WebKit tests on shard 1 and 13–20 on shard 2. With no time budget per shard, nobody saw the drift. The extra 1–8 minutes was GitHub's finalization, not a leftover process: no log shows a terminated orphan.
- **Error class:** A CI shard grows toward its job limit.
- **Guard:** Time-balanced shards from `scripts/test-weights.json`, five unit and seven WebKit shards, and `--max-minutes 20` per shard. `scripts/run-tests.test.ts` checks the split and the over-limit failure ([#1260](https://github.com/k2b-dev/cloud/issues/1260)).
