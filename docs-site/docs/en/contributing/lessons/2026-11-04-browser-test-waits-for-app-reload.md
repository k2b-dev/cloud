### A browser test visited the next page while the app was still reloading

- **What happened:** The AI boundary test in `AiReview.browser.test.ts` saved a new provider and then opened another page right away. Saving reloads the area on the new provider with `window.location.assign`, so the test's own `page.goto` raced that reload and Chromium aborted it with `net::ERR_ABORTED`. It failed on unrelated pull requests.
- **Root cause:** The test waited for the save request, not for the navigation the save starts.
- **Error class:** A test step that navigates while a navigation started by the app is still in flight.
- **Guard:** After an action that reloads or navigates, a test waits for the resulting URL and the ready marker (`page.waitForURL`, then `body[data-ready="true"]`) before its next `goto`. The boundary test does so now.
