### Studio mistook a navigation cancellation for a page failure

- **What happened:** The Studio management browser test intermittently failed in WebKit with an access-control message for the page's own capability catalog.
- **Root cause:** The suite adopted the shared WebKit launcher in #935 but retained a raw page-error listener. WebKit reports a same-origin load refused while a test-started document navigation is pending as a page error, even when the application handles the failed request.
- **Error class:** Browser navigation diagnostic mistaken for an unhandled application failure.
- **Guard:** The Studio management test uses `pageErrors(page)` and retains its empty-error assertion. `packages/ui/test/browser.browser.test.ts` reproduces the navigation refusal and verifies that the collector still reports real cross-origin failures, unhandled rejections and refusals during page-started navigation.
