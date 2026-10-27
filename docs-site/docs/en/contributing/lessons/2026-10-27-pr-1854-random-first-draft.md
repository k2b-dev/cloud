### An edit test returned to its random first draft

- **What happened:** The profile-picture browser test waited for an unsaved-change message until Playwright timed out in #1854.
- **Root cause:** The first draft was random. When it already had red hair and an afro, the test's hair choices returned to that draft, so the dialog correctly showed no change.
- **Error class:** Time: a test depended on randomness in its starting state.
- **Guard:** `ProfilePicture.browser-harness.tsx` pins the random seed to that starting draft. The browser test checks the unchanged state, then selects glasses before expecting an unsaved change and saving. No deadline was increased.
