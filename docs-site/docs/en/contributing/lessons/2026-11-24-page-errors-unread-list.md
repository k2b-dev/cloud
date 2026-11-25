### A page-error check that could never fail

- **What happened:** Mail's v2 pilot fixture ran `installPageSwap()` in the page's head, before `document.body` existed, and every page threw. Its browser test still passed: it checked `expect(pageErrors(page)).toEqual([])` after the page had loaded. Five checks in Assistant's `code-decision.browser.test.ts` had the same shape.
- **Root cause:** `pageErrors(page)` collects errors from its own call on and returns a new list each time. A list made inside `expect(...)` after the page loaded, or a call whose list is thrown away, starts empty and stays empty.
- **Error class:** A check that reads a collector it created after the events it should see, so it passes whatever happened.
- **Guard:** The `page-errors` rule reports every `pageErrors(...)` whose list is made for `expect(...)` or thrown away, without a baseline. A test keeps the list it starts before the page loads and reads that one.
