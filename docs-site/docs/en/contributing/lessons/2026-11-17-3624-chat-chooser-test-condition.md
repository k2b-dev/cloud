### Wait for the chat chooser's state after an interaction

- **What happened:** WebKit rejected the chat chooser's conflict-recovery browser test because a button's background-color transition started while `settled()` was checking the page.
- **Root cause:** The test waited for generic animation settlement after selecting a chat and after a failed save, although its next step only required the save button to be enabled.
- **Error class:** A browser test used global animation settlement instead of its own observable completion condition.
- **Guard:** Both chooser tests wait for the enabled save button. The conflict test still waits for the conflict message and verifies the binding reread, open dialog, exact revisions and successful retry. Product animations, assertions and timeouts stay unchanged.
