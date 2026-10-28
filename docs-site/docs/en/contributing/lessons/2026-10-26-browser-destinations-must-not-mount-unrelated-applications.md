### Browser destinations must not mount unrelated applications

- **What happened:** Studio's WebKit navigation test reported runtime fetch errors while leaving its dummy edit-chat page.
- **Root cause:** The fixture mounted another autostarting Studio instance at that destination; the next navigation interrupted its requests. The fullscreen step also left before the app was ready.
- **Error class:** A browser fixture creates unintended asynchronous work between assertions.
- **Guard:** `apps.browser.test.ts` serves a static edit-chat destination and verifies the fullscreen app's visible revision before navigating onward. Runtime error assertions and timeouts remain unchanged.
