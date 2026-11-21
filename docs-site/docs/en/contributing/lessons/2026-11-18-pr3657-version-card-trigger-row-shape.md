### A shared trigger assumed a column absent from two source tables

- **What happened:** Publishing a version decision or withdrawing a version failed, blocking the write and its live card update.
- **Root cause:** The shared card trigger read `NEW.code_id`. Decisions and withdrawals contain only `version_id`; activations contain both fields.
- **Error class:** A shared database trigger assumes the row shape of only one attached table.
- **Guard:** The activation integration test enumerates every attachment, exercises decision, withdrawal, activation insert and activation update, checks the queued author and Code, and uses `sql-meter` to pin each client write at one statement with and without its card trigger. The trigger obtains both fields from one indexed version lookup.
