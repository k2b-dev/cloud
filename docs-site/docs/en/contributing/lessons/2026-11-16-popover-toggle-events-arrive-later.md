### A popover test read its toggle events before they arrived

- **What happened:** The Chat emoji picker test failed once in CI on an unrelated PR (#3574): after the second opening, the recorded `toggle` events were one entry short.
- **Root cause:** A popover's `toggle` event arrives in a task after the change, and a browser merges a still-queued one with the next change. The test read the list as soon as the picker had focus and reopened right after Escape, so a slow runner saw the close and the reopening as one event or saw the last one late.
- **Error class:** A test that reads asynchronously dispatched events at the moment the state changed, instead of waiting for them.
- **Guard:** `ChatEmojiPicker.browser.test.ts` waits for each recorded state (`toggled(page, state)`) before it reads the list or changes the picker again; the same pattern applies to every test that records `toggle` events.
