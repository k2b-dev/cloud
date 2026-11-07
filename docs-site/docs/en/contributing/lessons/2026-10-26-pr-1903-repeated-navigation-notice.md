### A navigation guard mistakes repeated feedback for failure

- **What happened:** The Chat panel's archive-and-back regression failed when its notice locator matched two identical preparation messages.
- **Root cause:** Separate refused navigation actions can notify again after the existing throttle elapses. The test accidentally required one matching toast rather than visible feedback and preserved navigation.
- **Error class:** Feedback assertions assume transient uniqueness
- **Guard:** `ChatPanel.browser.test.ts` waits for a matching preparation notice without requiring toast uniqueness. The same regression still verifies that archive, Back, panel close and provider switching cannot navigate away from the pending send and that no message is posted before history is ready. Toast duration and test deadlines remain unchanged.
