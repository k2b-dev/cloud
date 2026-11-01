### A disposed test window still discovered file providers

- **What happened:** The Mail attachment test intermittently saw a capability catalog lookup before it requested the lazy recipient context.
- **Root cause:** The DOM harness called `window.close()` on a directly constructed Happy DOM window. That method only closes script-opened windows, so the import-time provider prefetch timer in `packages/cloud/src/browser/files.tsx` survived cleanup. A controlled reproduction produced one catalog call in the next harness with the old cleanup and none with `window.happyDOM.close()`, which cancels the window's tasks before completing asynchronous teardown.
- **Error class:** Incomplete test resource cleanup leaks background work into later tests.
- **Guard:** `packages/ui/test/dom-harness.behavior.test.ts` schedules a Happy DOM window timeout and animation frame, cleans up the window, opens the next harness, and verifies that neither callback runs. This checks window timers; bare global timers still need their own cleanup. The Mail attachment assertions and test timeouts remain unchanged.
