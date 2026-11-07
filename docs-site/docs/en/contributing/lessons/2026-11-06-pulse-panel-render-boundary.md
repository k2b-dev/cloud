### One Pulse panel that could not render blanked the whole dashboard

- **What happened:** A dashboard with a line panel over `toStartOfDay(ts, :base_tz)` showed only the island error "This section could not be displayed", although every panel returned `ready` with data (#2713).
- **Root cause:** The line adapter set the x-axis domain to the dashboard window. A day bucket that starts before `:from` fell outside it, and the stdlib chart threw a `RangeError` while rendering. Panels had no boundary of their own, so the throw reached the island boundary.
- **Error class:** A render-time throw in one item of a composed view escapes to the page boundary and hides every sibling, while the data layer reports success.
- **Guard:** `dashboard-data.test.ts` renders a bucket before the window through the stdlib line chart. `Dashboard.browser.test.ts` requires a panel whose result throws during render to fail alone with a retry while the other panels render.
