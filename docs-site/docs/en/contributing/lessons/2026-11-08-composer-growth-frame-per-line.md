### Give every measured step its own frame

- **What happened:** The ChatComposer growth test failed in CI with exactly 10 sampled frames where it requires more than 10, on a pull request that did not touch `@k2b/ui`.
- **Root cause:** The test typed 16 lines without waiting between them. Under CI load several lines landed in the same animation frame, so the frame-based probe saw fewer growth steps than the test assumes.
- **Error class:** A frame-sampling assertion depends on how many input events the browser batches into one frame.
- **Guard:** `packages/ui/src/chat/chat-composer.browser.test.ts` waits one animation frame after each typed line and then requires more than 15 sampled frames, so every growth step is measured regardless of load. Convention `frame-per-measured-step`: when a test asserts on per-frame samples, give each input step its own frame instead of relying on browser batching. Keep the default test budgets.
