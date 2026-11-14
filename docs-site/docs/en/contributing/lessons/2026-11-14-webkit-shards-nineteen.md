### WebKit shards grow with the measured workload, not with one file

- **What happened:** Adding one small browser test file in #3317 (2.8 seconds in WebKit) pushed the planned WebKit shard to 660.05 seconds and failed the 660-second planning guard.
- **Root cause:** The browser weights were last refreshed at 382 files. With 443 files, fresh maxima from six recent runs, including two failed ones, predict 681.5 seconds for seventeen shards even without the new file; the old table hid that growth until a new file tipped the plan.
- **Error class:** Capacity planning from an outdated measurement table.
- **Guard:** The existing `scripts/run-tests.test.ts` test `CI webkit shards cover the selection exactly once and fit the measured budget` caught it. The refresh follows [What CI runs](/en/contributing/testing#what-ci-runs): new weights from `bun scripts/test-weights.ts --mode browser`, nineteen shards with 50.5 seconds of room, and the unchanged 20-minute budget and 55% target. No new guard fits: refresh the weights whenever browser suites grow, as that page already asks.
