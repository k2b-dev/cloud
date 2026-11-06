### A recovered write intent replaces a new contact

- **What happened:** Restoring an unresolved chat creation silently substitutes its recipients for the person selected in another app.
- **Root cause:** A recovered write intent replaces a new contact.
- **Error class:** A recovered write intent replaces a new contact.
- **Guard:** Test: Chat `chat-dialogs.behavior.test.tsx` refuses a conflicting contact, retains the original key through dismissal, resumes only an exact matching intent, and permits the intended contact after the old attempt is resolved or explicitly cancelled.
