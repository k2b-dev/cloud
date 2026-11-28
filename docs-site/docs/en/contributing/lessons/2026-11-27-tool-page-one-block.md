### A short result beside a column of options left half the page white

- **What happened:** In the Tools images (v6), the password took the top 290 px of its pane; below it the pane stayed white down to 900 px, beside a column of options. Every tool page built from the same two-pane layout looked the same.
- **Root cause:** `Pane.Split` runs both columns and their seam to the end of the page, so a result that is short by nature (a password, a UUID, a hash) leaves the rest of its column empty.
- **Error class:** A layout for content of unknown height that sizes by the page instead of by its content.
- **Guard:** A tool page is one pane with its result and its options one under the other (`ToolPane` in `packages/tools/src/frontend/ToolsScreen.tsx`), fields and results at the reading measure. The browser test "a tool page is one block" in `packages/tools/src/frontend/tools-v2.browser.test.ts` checks every such page at 1440 px for one pane, with every field and fact at most 760 px wide.
