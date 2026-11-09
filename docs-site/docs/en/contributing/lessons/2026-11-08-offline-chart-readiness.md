### Read offline chart readiness with the asserted state

- **What happened:** The first offline chart browser case exceeded its five-second deadline while waiting for the histogram SVG. The remaining cases, including both new dot matrices, passed.
- **Root cause:** The cold frame path used separate browser calls to wait for two SVGs, read their state, focus the chart, and wait for a tooltip before reading it. These calls used part of the same interaction budget.
- **Error class:** Browser transport overhead makes a cold interaction guard exceed its deadline.
- **Guard:** The state-read locator requires both histogram and gauge SVGs to be visible, and the tooltip read requires a visible tooltip. `locator.press` focuses the chart and sends the real keyboard event in one call. All 14 assertions, both SVG visibility conditions, offline loading, real keyboard input, and the five-second timeout remain unchanged.
