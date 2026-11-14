### Share browser setup and wait for the font itself

- **What happened:** The late icon font layout test exceeded Bun's default five-second timeout in CI (#2668).
- **Root cause:** One test paid for browser launch, asset preparation, two isolated page layouts, polling for font completion, and browser shutdown within the same budget.
- **Error class:** Independent browser scenarios and process setup share one test deadline.
- **Guard:** `packages/core/scripts/tabler-font.browser.test.ts` shares browser and asset setup in `beforeAll`, closes the browser in `afterAll`, checks each viewport in its own case, and awaits `document.fonts.load()` instead of polling. Convention `shared-browser-viewport-cases`: share browser setup across independent viewport cases, keep pages local to each case, and await the resource's completion signal. Keep the default test and hook budgets.
