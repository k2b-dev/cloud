### Keyboard chart inspection must cancel older pointer work

- **What happened:** Home selected the first observation, then an older pointer animation frame restored the last observation and its legend values.
- **Root cause:** Pointer movement was deferred to the next frame while keyboard inspection, focus and pinning left that queued work active.
- **Error class:** Older asynchronous input overwrote a newer user action.
- **Guard:** The shared inspector cancels pending pointer work before keyboard navigation, focus and pinning. `line-forecast.browser.test.ts` queues a move and Home synchronously, then checks the first value after the page settles. It failed with 20 before the fix and expects 10 afterwards.
