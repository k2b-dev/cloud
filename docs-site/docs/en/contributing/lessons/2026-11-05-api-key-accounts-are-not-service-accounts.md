### The account behind an API key read as a service account

- **What happened:** The access dialog listed the account behind an object's API keys under "Service accounts" („Dienstkonten“), and every label called it „Dienstkonto“. Concept v28 §14 W11 reserves that word for the account that Code runs as.
- **Root cause:** Before Code had its own service accounts, `resource_bound` was the only kind without a person. The dialog grouped by that kind, and the shared label for the kind said "service account".
- **Error class:** A kind label kept its old meaning after the glossary split one term into two.
- **Guard:** `AccessDialog.behavior.test.tsx::the account behind an object's API keys is an API key, never a service account` checks the section, the label and the key icon. `PermissionEditor.behavior.test.tsx` pins the label of every kind.
