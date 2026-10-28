### Server-rendered charts need an island for inspection

- **What happened:** Grids Custom App charts displayed their plots but offered no hover, keyboard, or tap inspection on published pages. The builder preview also lost category names in tooltips.
- **Root cause:** The page rendered the chart outside an island. The plot deliberately suppressed category labels inside SVG, so default tooltips could not recover those names or the block's value format.
- **Error class:** Inert server-rendered interaction.
- **Guard:** Grids `chart-tooltip.test.ts` checks category and aggregation labels and value formatting. `page.render.test.tsx` checks the chart island, SVG parity, and display-only serialized props for signed-in and anonymous pages. `chart-tooltips.browser.test.ts` covers real island mounting, hover, keyboard, tap, and server/browser layout parity at desktop and phone widths.
