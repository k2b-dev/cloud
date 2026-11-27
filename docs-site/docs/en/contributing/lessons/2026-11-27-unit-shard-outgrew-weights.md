### Split a unit suite before it outgrows its shard

- **What happened:** The unit shard 6/13 stopped at its 20-minute budget during `@k2b/ui rest`, so a merge group failed although no test failed (#4386). In green runs the same shard already took up to 18.8 min.
- **Root cause:** `scripts/test-weights.json` still weighted `@k2b/ui rest` at 693 s. Many new v2 browser tests had grown it to 1000 s. That is more than the 15-minute shard target for one suite alone, so no plan could balance it. `@k2b/cloud-app-notebooks` (921 s) and `@k2b/cloud rest` (876 s) were close behind.
- **Error class:** The measured time of a suite drifts away from its committed weight until one suite fills a shard by itself.
- **Guard:** The unit plan test in `scripts/run-tests.test.ts` now also holds the slowest shard within a tenth of the even share. A suite that grows past that share must split into `test:part:*` scripts. Refresh the weights with `bun scripts/test-weights.ts --run <ids> --mode unit` when a shard warns that it is above its target.
