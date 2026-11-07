### Settings categories and toolbars drew divider lines

- **What happened:** On a phone, the settings category row showed vertical lines between groups and a line under the row, and its last category ended at a hard edge. The side rail had a line beside it, and toolbars and the Markdown editor toolbar drew lines between their groups and under the strip.
- **Root cause:** The styles grouped content with 1px borders and line separators instead of space or a surface step. The row's 1rem scroll fade lay almost entirely inside its 0.75rem end padding, so the last visible label was cut without a fade.
- **Error class:** A shared component separates groups or regions with a decorative line instead of space or a surface step.
- **Guard:** `packages/ui/src/layout/settings-modal.browser.test.ts` ("separates groups and the category list from the panel without lines", "the phone row fades out into the last category it cuts") and `packages/ui/src/actions/toolbar.browser.test.ts` ("a separator groups actions with space and draws no line").
