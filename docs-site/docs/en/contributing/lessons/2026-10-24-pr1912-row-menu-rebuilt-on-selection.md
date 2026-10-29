### A closed row menu was rebuilt on every selection

- **What happened:** Switching mailboxes on a phone took longer than needed because selecting a row or replacing controller callbacks rebuilt the closed menu DOM of every row.
- **Root cause:** The menu items depended on aggregate reactive state, although the available actions stayed the same.
- **Error class:** Unchanged actions inherit aggregate reactive dependencies.
- **Guard:** Test: Mail `MailConversationRow.behavior.test.tsx` retains menu nodes through selection and callback changes, invokes the current callback, and updates changed or removed actions. Convention: memoize the action values that decide the menu shape.
