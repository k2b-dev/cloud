### Balanced shards still need measured slowdown headroom

- **What happened:** WebKit shard 4 repeatedly exhausted its 20-minute budget while its completed tests passed, blocking release and unrelated pull requests.
- **Root cause:** Duration-based sharding used an outdated table covering 289 of 380 browser files and allowed 15-minute predictions. Recent CI showed a 1.61x p95 slowdown across shared completed files in the failing jobs; that margin could not absorb it. The cause of the runner slowdown remains unconfirmed.
- **Error class:** Capacity planning without measured performance headroom.
- **Guard:** `scripts/run-tests.test.ts` rejects a WebKit matrix whose expected shard exceeds 55% of the unchanged 20-minute budget, and verifies exact suite coverage. The refreshed timing table and fifteen shards fit 11 minutes; `11 * 1.61 + 2` reserves the full browser warm-up inside 20 minutes. `scripts/test-weights.test.ts` checks that refresh recommendations use the tighter browser target. The measurements and derivation are recorded in the Testing guide.
