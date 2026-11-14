### Use native has() instead of the Playwright has filter on large pages

- **What happened:** The WebKit test "calendar starts flush with newest weeks in /en/ui/charts at 800px" timed out at 5 s in a sync gate. The Sankey tests on the same page ran at 4.5–4.9 s, on `main` too.
- **Root cause:** `Locator.filter({ has })` matches in Playwright's page script. On the chart overview (26 charts, about 4,300 elements) WebKit spent about 0.9 s on `count()` and 3.0 s on `evaluate()` for one locator. Native `.k2b-chart:has(svg[data-calendar])` finds the same element in milliseconds.
- **Error class:** A test locator does script-side matching across a large document, so the test's own lookup uses up the per-test budget.
- **Guard:** The overview tests use native CSS `:has()`, with the same assertions and timeouts. Issue #3021 records the measurement and the remaining `filter({ has })` uses to review on large pages.
