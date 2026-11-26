### v2 menus and popups missed upstream focus and keyboard fixes

- **What happened:** On `@ui-sdk/core` 0.1.0-beta.14, Escape did not close a hover-opened submenu first, a page shortcut could take Escape from an open layer, Tab in Safari could leave a trapping popup, and Tab out of a popup without a trigger did not return to where it opened. With beta.17 (#4214), v2 menus, dialogs and popovers get these upstream fixes; no adapter workaround in `packages/ui/src/v2/behavior` became obsolete.
- **Root cause:** The pinned upstream behavior library lagged three beta releases behind its focus and keyboard fixes.
- **Error class:** A pinned exact dependency keeps known upstream defects until someone bumps it.
- **Guard:** None new, because the existing adapter contract tests and the v2 behavior and browser tests in Chromium and WebKit already cover the changed overlay, menu and select behavior and gate every later bump.
