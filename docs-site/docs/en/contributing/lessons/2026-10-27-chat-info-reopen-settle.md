### A chat info test reopened before its closing layout settled

- **What happened:** The WebKit chat info test intermittently failed to reopen Info after closing it, timing out while waiting for the info URL.
- **Root cause:** Suspected: the test treated the history URL and a single `aria-expanded` read as completion of the closing layout. The second click could arrive while the header was still moving or a view transition was active.
- **Error class:** State sampled before it settled.
- **Guard:** `ChatWorkspace.browser.test.ts` waits for the actual detail panel to be hidden and calls `settled(page)` before reopening or checking Back. The pointer moves away from header controls so hover changes do not start new animations during the wait; the normal motion path remains covered.
