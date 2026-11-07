### A Mail menu test read the row state before the menu had closed

- **What happened:** `a list row opens its … menu on right-click and with the context-menu key or Shift+F10` failed on several unrelated pull requests after #2228: right after `dismiss()` the row still reported an open menu and a hidden title (#2769).
- **Root cause:** `dismiss()` waits until the dropdown is hidden, but the row restores its own class and `title` one step later. The test read that state once, without waiting, so a slower runner saw the previous state.
- **Error class:** A browser test reads state that a UI transition updates asynchronously, right after an action, instead of waiting for the condition it asserts.
- **Guard:** The test now waits for the expected row state with `page.waitForFunction` before it compares it, after opening and after closing the menu. No new repository rule: the `settle-reads` check covers style and geometry reads; class and attribute reads are too common to flag statically, so the waiting helper is the convention.
