### The webhook tester's request table scrolled sideways at tablet and laptop widths

- **What happened:** In Tools › Webhook-Tester the request table scrolled sideways by 207 px at 768 px and by 83 px at 1100 px, so the time and the status of a request slid out of view.
- **Root cause:** Every text column had a fixed minimum width (`min-w-[240px]`, `min-w-[260px]`, …) and every cell keeps its value on one line, so the table could never be narrower than the sum of its columns. No column had a `priority`, so nothing gave way.
- **Error class:** A primary list whose columns carry fixed minimum widths instead of a priority and a truncating flexible column.
- **Guard:** `catalog.browser.test.ts` opens the webhook tester with classic scrollbars, without touch, at 768 px and at 1100 px with a request open beside the table, with long paths and bodies, and requires `scrollWidth <= clientWidth` on every `.k2b-table-wrap`.
