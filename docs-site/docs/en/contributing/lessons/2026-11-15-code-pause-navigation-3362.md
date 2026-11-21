### Wait for the navigation caused by an asynchronous action

- **What happened:** The Code administration browser test sometimes saw no pause request after confirming the action in WebKit.
- **Root cause:** `waitForLoadState("load")` resolved against the already loaded document while the confirmation still dispatched its asynchronous POST and reload.
- **Error class:** A browser assertion races an asynchronous mutation by waiting for a state that was already reached.
- **Guard:** `packages/core/src/pages/admin/code/CodeArea.browser.test.ts` starts waiting for the new document’s load event before confirming, then checks the exact pause request and both refused-resume reasons in Chromium and WebKit.
