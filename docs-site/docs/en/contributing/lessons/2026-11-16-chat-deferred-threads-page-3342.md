### A fixed pause read the Chat threads page before its code arrived

- **What happened:** `ChatWorkspace interactions > opening a system chat keeps the private unread total intact at Back` failed now and then in CI: the threads page's Back link was missing, so its target read as `undefined`.
- **Root cause:** Since #2623 the threads page loads its code on first open and shows a loading surface without a header until then. This test is the first in its file to open that page, so it pays the cold import, and on a busy runner the import outlasted the fixed 60 ms `settle()` pause. The product showed the intended loading state; no Back target was lost.
- **Error class:** A test waits a fixed time for UI whose code is imported on demand, so the first test in a process to open it races the import.
- **Guard:** `settle()` in `ChatWorkspace.behavior.test.tsx` also waits until no deferred Chat view shows its loading surface (`.chat-deferred-feedback [data-loading]`), so every test that opens a deferred subpage reads it only after its code arrived.
