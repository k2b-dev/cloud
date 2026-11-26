### v2 column grips were focusable separators that did nothing

- **What happened:** The grip on a v2 pane seam (`k2-grip`) and the column grip in a table head (`k2-cgrip`) stood in the tab order as `role="separator"` with a value, but neither a drag nor a key moved a column.
- **Root cause:** The grips shipped as shape only, with the behaviour left for later ("dragging and the keyboard come with the behaviour layer"); the resize adapter that existed was never connected to them.
- **Error class:** A focusable control without behaviour: an element announced as operable before anything operates it.
- **Guard:** `packages/ui/src/v2/grips.browser.test.ts` drags and keys every kind of grip (sidebar, pane left and right, table column) in Chromium and WebKit, checks the live `aria-valuenow`, `aria-valuemin` and `aria-valuemax`, and runs axe on the page.
