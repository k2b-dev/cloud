### A Chat test read the composer lock before the draft store had failed

- **What happened:** `assistant can leave an empty panel when session storage is unavailable` failed on an unrelated chart pull request (#2772): right after the panel fixture was ready, the composer was still enabled.
- **Root cause:** The test read the textarea's disabled state once. The composer locks only after the draft store reports its failure, which can land after the fixture is ready, so a slower runner saw the earlier state.
- **Error class:** A browser test reads state that a UI transition updates asynchronously, right after an action, instead of waiting for the condition it asserts.
- **Guard:** The test waits for the draft notice and for a disabled composer before it asserts the lock. Same convention as [the Mail menu lesson](2026-11-07-mail-row-menu-state-read-before-close.md) and [the Notebooks slash lesson](2026-11-08-slash-suggestion-read-before-filter.md); disabled, class and text reads are too common to flag statically.
