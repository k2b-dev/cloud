### A sent chat message showed twice until its answer arrived

- **What happened:** After a send, the chat showed the stored message and the pending send side by side, each with the same card, until the POST answer arrived. The Chat shared-elements browser test failed with two own rows (#2699).
- **Root cause:** The workspace matched a pending send to its stored message only by the message ID from the POST answer. The live event carries the stored message and can arrive first; message views did not include the `clientId`, so nothing linked the two until the answer came.
- **Error class:** Optimistic UI reconciles through one transport's response and ignores the same result arriving on another channel first.
- **Guard:** Message views and live events carry the `clientId`, and the workspace replaces a send by it. `ChatShared.browser.test.ts` holds the send's answer with `holdSendAnswers()` and requires one own row while only the live event has arrived; its pages also use the harness clock, so the test does not depend on the time of day.
