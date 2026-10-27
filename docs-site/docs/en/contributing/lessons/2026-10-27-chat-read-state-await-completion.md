### Read-state tests waited for intermediate navigation and feed state

- **What happened:** A Chromium read-state test failed because view-transition animations started during `settled(page)`. Burst cases also failed while dereferencing a missing read report or waiting for a virtualized message row.
- **Root cause:** History updates precede view-transition completion, a read-report list can still be empty while polling, and a received message need not have a rendered row in a virtualized feed.
- **Error class:** State sampled before it settled.
- **Guard:** `ChatWorkspace.browser.test.ts` waits for the active view transition to finish before opening message menus, polls missing read reports as pending, and confirms burst delivery using the feed's accessible set size instead of a particular virtualized row. Timeouts and motion remain unchanged.
