### Access fixtures must follow the current account contract

- **What happened:** After the account-presentation merge, a Files template grant test failed with PostgreSQL `42703`, and the ordinary service-account browser test timed out while waiting for its row.
- **Root cause:** The isolated Files fixture omitted the account title/handle migration used by the display resolver. The browser locator still expected a technical account name after the fixture supplied a human display name.
- **Error class:** Test fixtures and selectors drift from a changed dependency contract.
- **Guard:** The template audit fixture runs the real account title/handle migration and checks the saved Code grant's handle through the normal grant and list services. The browser test locates the displayed account, checks that only View/Edit are offered, and waits for both the exact update callback result and visible saved feedback. Its five-second timeout stays unchanged.
