### Separate fixture controls from product interaction

- **What happened:** Calendar panel geometry cases exhausted their five-second deadline while switching through states, although their geometry assertions passed.
- **Root cause:** Each width case combined SSR layout, touch/resize and every request state under one default deadline. State transitions also used Playwright actionability and scrolling on raw test-only buttons, which only change a fixture signal.
- **Error class:** A focused behavior guard spends its budget testing unrelated fixture machinery.
- **Guard:** Keep layout, inspection, resize and request-state proofs in separate cases. Measure SSR label geometry once per width, dispatch fixture controls' click events directly, and reuse the suite's browser for first-load pages. Await `settled(page)` before measuring the real panel and viewport. Keep actual tap and Retry actions on product elements. Every geometry, SSR, scroll, state and resize assertion and the five-second deadline remain unchanged.
