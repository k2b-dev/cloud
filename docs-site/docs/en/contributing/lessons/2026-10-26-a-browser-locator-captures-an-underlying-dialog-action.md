### A browser locator captures an underlying dialog action

- **What happened:** Before asynchronous Back opens a confirmation, an unscoped button label matches the form action. The confirmation hides that retained button, so the click waits on the wrong element.
- **Root cause:** The locator resolved the form action before the asynchronous confirmation appeared.
- **Error class:** A browser locator captures an underlying dialog action
- **Guard:** Test: Pulse `PulseWorkspace.browser.test.ts` scopes Cancel and Discard to the named confirmation, checks that the form action is visible while the confirmation action is absent, and verifies draft preservation and final dismissal.
