### Grids' columns kept the widths of the wide screen on the phone, and its query could not keep the sidebar away

- **What happened:** In Grids' v2 screens, a list with `width={{ min: 480 }}` stayed 480 px wide at 390 px and showed its desktop table instead of rows. The search that heads a list column stayed 184 px wide instead of filling the column. The query view needs about 640 px for its main column, but beside that column the sidebar stayed a column at 1024 px.
- **Root cause:** The phone rule set `min-width: 0` only for a column without `width`, so a column with `width` kept the minimum of the wide screen. A search had one width in every bar. A column without `width` always counted 400 px for the drawer, and nothing could declare more.
- **Error class:** A rule of the wide screen (a minimum width, a fixed width) reaches a place it was not written for: the phone, or a column's own head.
- **Guard:** `packages/ui/src/v2/pane-fit.browser.test.ts` checks a column with a minimum of 480 px at 390 px, a search that fills a column's head, and the drawer beside a main column with `min={640}`, on the server's page and after the page comes alive. The test failed first and passes now.
