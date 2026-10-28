### Calendar day view dropped the focus when later days loaded

- **What happened:** Focusing the last "Nothing planned" button loaded later days. Focus fell to the page body, and Tab missed the Spaces task tray ([#1225](https://github.com/k2b-dev/cloud/issues/1225)).
- **Root cause:** A run of empty days used its joined day keys as its list key. When loaded days joined it, the key changed and the view replaced the focused button. A run now keeps the identity of a previous run that shares a day with it.
- **Error class:** Focus lost on refresh.
- **Guard:** The `@k2b/ui` day view browser test keeps the same focused button as days join a run at either end. The Spaces tray keyboard test waits for the later days before it checks focus and presses Tab. Convention [A11Y-16](/en/docs/conventions/frontend#accessibility-a11y) applies the same rule to other lists.
