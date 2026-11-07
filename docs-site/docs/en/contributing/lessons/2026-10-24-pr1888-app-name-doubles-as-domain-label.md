### The German Accounts app name also labelled account counts

- **What happened:** Renaming the German Accounts app to "Zugänge" would also have renamed the account total on the overview, and the Core app credentials collided with the personal account label.
- **Root cause:** The overview count shared the app-name message key, and app credentials reused the account wording.
- **Error class:** An app name doubles as a domain label.
- **Guard:** Tests: Accounts `frontend/messages.test.ts` keeps the German app name separate from the account total; Cloud `platform-messages.test.ts` and `cli/admin.test.ts` distinguish app keys from the personal account. Convention: review each name in context across registration, search, navigation, CLI and Help.
