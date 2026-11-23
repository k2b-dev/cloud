### The v2 layout measure reported a double line under a tab that was drawn whole

- **What happened:** `measureV2Layout` reported a double line under the active tab of the Mail mockup at 390 px. The tab row was `overflow: clip visible`, and the 2 px tab mark showed whole over the head line.
- **Root cause:** `clipOf` in `packages/ui/test/measure-v2-layout.ts` cut both axes to the parent box as soon as one axis was not `visible`. That shortened the 2 px mark to 1 px, and the measure counted it as a hairline beside the head line.
- **Error class:** A layout measurement that models clipping more coarsely than the engine draws it, and reports a problem the screen does not show.
- **Guard:** The browser test `measure-v2-layout.browser.test.ts` measures the same tab row twice. With `overflow: clip visible` it expects no problem; with `overflow: hidden`, where the engine really cuts the mark to 1 px, it expects the double line.
