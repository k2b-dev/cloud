### Bound each chart catalog variant's browser work

- **What happened:** Pulse's catalog browser test passed in 29.21 seconds on the PR, then reached its unchanged 30-second deadline in the merge group.
- **Root cause:** One test drew 17 panels through data, loading, error, empty and recovery for three viewport/theme variants. The cumulative work left less than a second of room in WebKit; this test used no `filter({ has })` locator.
- **Error class:** Several independent browser scenarios share one deadline whose workload grows with the catalog.
- **Guard:** `Dashboard.browser.test.ts` runs desktop light, phone light and phone dark as separate bounded tests. Each retains all 17 kinds, exact frame comparisons, Pareto accessible-name checks, keyboard inspection and phone taps. They share the file's browser and harness, keep the same timeout, and close their own page.
