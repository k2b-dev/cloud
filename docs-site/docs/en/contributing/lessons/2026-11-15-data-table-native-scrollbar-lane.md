### A table lost its scrollbar lane when its code arrived

- **What happened:** In WebKit, a data table that overflows sideways was 8 px taller in its server frame than after its code arrived (BlockTree at 390 px on `feat/code`, Sync 50, #3425). A first fix with a fixed bottom padding moved the table in Chromium instead, because headless Chromium uses overlay scrollbars that take no room.
- **Root cause:** The server frame shows the native horizontal scrollbar, which takes room in WebKit and none with overlay scrollbars. `data-scrollbar-enhanced` is set only in the browser and hides the native scrollbar for the custom overlay, so the table lost that room after hydration. A fixed padding cannot match both scrollbar kinds.
- **Error class:** A layout difference between the server frame and the hydrated frame that depends on the browser's scrollbar kind.
- **Guard:** DataTable measures the native lane once on mount (`offsetHeight - clientHeight`) and keeps it as `padding-bottom` for an enhanced table that overflows sideways (0 with overlay scrollbars). `css-hygiene-contract.test.ts` pins the rule; the BlockTree browser test on `feat/code` checks the height in WebKit and Chromium.
