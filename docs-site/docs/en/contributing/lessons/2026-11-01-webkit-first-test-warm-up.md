### The first test of a fresh WebKit container timed out on a one-time cost

- **What happened:** The merge queue dropped entries because the first test of WebKit shard 1 hit the 5 s limit, while the same test passed in 1.8 to 2.7 s for its other five variants.
- **Root cause:** A new Playwright container has no Mesa shader cache. The first composited frames compile 70 to 100 shaders, and that cost fell inside whichever test drew first (#2149).
- **Error class:** A one-time setup cost of the environment that counts against the budget of an unrelated test.
- **Guard:** `bun run test --browser` runs `packages/ui/test/browser-warmup.ts` before the first suite. `scripts/run-tests.test.ts` checks that a failed warm-up stops the run before any suite starts.
