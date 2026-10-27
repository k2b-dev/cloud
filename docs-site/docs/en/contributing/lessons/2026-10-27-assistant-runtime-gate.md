### A delayed runtime test let its runtime load

- **What happened:** The Assistant panel test intermittently found the runtime ready while it was supposed to remain blocked, failing the WebKit merge queue.
- **Root cause:** Suspected: the request gate selected Assistant by the new iframe's current URL. WebKit can request its module before the frame reports the destination URL, so the conditional gate could let the runtime through.
- **Error class:** A browser fixture identifies an in-flight request through mutable frame state.
- **Guard:** `ChatPanel.browser.test.ts` waits for Chat's runtime to finish before arming an unconditional module gate and switching to Assistant. It still checks that the Assistant workspace accepts and protects a draft while its runtime remains absent.
