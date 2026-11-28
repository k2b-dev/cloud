### A test waited for an address the page already had, and its next navigation raced the page's reload

- **What happened:** The outgoing mail admin test saved an app's sending access and then waited for `location.search` to contain `app=backoffice` before it opened the page again. Saving loads that same address again, but the condition was already true before the save, so the wait returned at once; in WebKit the test's next navigation and the page's reload interrupted each other and the gate of #4174 failed.
- **Root cause:** The wait named a state the page already had instead of something only the save changes; the reload that the save starts was never awaited.
- **Error class:** A wait after an action whose condition already holds before the action, so it proves nothing about the action and the next step races it.
- **Guard:** The test marks the old document before Save and waits for a new document without the mark, as the Storage admin test does; testing.md ("Wait for conditions, not time") names the convention. The `test-waits` rule cannot catch the class, because whether a condition already holds depends on the page's state before the action, not on the test's text.
