### Table headers changed rendered text on the first client render

- **What happened:** Code page tables had an extra line break between the header and first row in WebKit's server-rendered text. The first client render removed it for both populated and empty tables. Chromium did not expose the difference.
- **Root cause:** Separate column and optional-details expressions left Solid's conditional comments and an empty text node after the last client header cell. The server header ended with a cell. WebKit's rendered-text traversal treats those trailing nodes differently. One keyed header list now ends with a real cell on both sides, including the optional details column.
- **Error class:** Framework-generated DOM anchors change browser-observable SSR output despite equal visible elements and styles.
- **Guard:** `packages/ui/src/content/data-table-parity.browser.test.ts` compares exact server and first-client rendered text and row geometry for populated, empty, and responsive-details tables at desktop and phone widths. `packages/core/src/code/page.browser.test.ts` keeps its exact full-page parity assertion. Both files run in Chromium and WebKit.
