### Lease fairness tests measured runner latency instead of turn order

- **What happened:** Mail fairness tests failed on unrelated pull requests when a sync exceeded a nine-second wait or a command took more than five seconds during a backfill.
- **Root cause:** The assertions included database statements, provider calls, worker scheduling and command creation outside the lease. Their elapsed time varied with runner load and did not establish which waiter acquired the lease next.
- **Error class:** Wall-clock duration used as a proxy for scheduling fairness.
- **Guard:** The backfill test in `provider-lease-fairness.integration.test.ts` holds a real provider turn until a competitor has entered the lease line, then drives the retry directly and requires that competitor to acquire the next turn while the holder’s continuation is registered. This excludes worker lateness, which legitimately loses temporary presence. Statement counters require one marker, one source deletion and one confirmation per move set. A controlled monotonic clock verifies the admission deadline and preserves queued commands without relying on database sleeps.
