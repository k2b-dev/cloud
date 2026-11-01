### A unit shard reached its time limit and failed an unrelated test

- **What happened:** A merge group failed on a Notes browser test with `fill: Target page, context or browser has been closed`. The pull request in that group did not touch the test.
- **Root cause:** Unit suites had grown to about 113 minutes on seven shards, while the weights still predicted 14.3 minutes for the slowest shard. In each of six recent runs one job took about 20 minutes. The runner stopped the active suite at its 20-minute budget, and the test that was running at that moment reported the closed browser. `@k2b/cloud` and `@k2b/ui` took up to 17 minutes alone, so more shards could not fix it without a split.
- **Error class:** A budget stop looks like a test failure in whichever suite runs last, and outdated weights hide how close the shards are to the limit.
- **Guard:** `test:part:*` scripts split both suites, the weights are refreshed and CI has nine unit shards. A runner test requires each `rest` part to exclude what the other parts run. The existing shard test fails when a predicted shard exceeds 15 minutes. The first line to read in such a failure is the annotation `Time budget exhausted`.
