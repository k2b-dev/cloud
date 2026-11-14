### Hover without Playwright's retry scroll around viewport boxes

- **What happened:** The WebKit bars family test failed now and then, also in the `main` merge queue: a sample's viewport box kept its size but moved down by 211 to 401 px.
- **Root cause:** `Locator.hover()` retries a failed actionability check with its own `scrollIntoView`, `block: "end"` on the first retry. The first category band then ended exactly at the viewport's bottom edge. The test compared viewport boxes taken before and after the hover, so it measured Playwright's scroll instead of the page.
- **Error class:** A test compares viewport coordinates across a Playwright action that can scroll the page on its own.
- **Guard:** `hoverInPlace()` in `packages/ui/test/browser.ts` checks that the target is at the point and moves the mouse there, without scrolling or retrying. A guard test shows that a retried `hover()` scrolls and `hoverInPlace()` does not. Issue #3013 lists the other tests with the same pattern.
