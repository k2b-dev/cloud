### Notification registration missed Bun schema errors

- **What happened:** Notification registration threw a missing-table error instead of deferring registration until Core's schema was ready.
- **Root cause:** The classifier read SQLSTATE only from `code`; Bun's server error used `errno: "42P01"` with `code: "ERR_POSTGRES_SERVER_ERROR"`.
- **Error class:** SQLSTATE read from the wrong driver field.
- **Guard:** Notification `catalog.test.ts` covers `42P01`, `42703`, and `3F000` in both `errno` and `code`, successful retry, and unchanged propagation of initial permission and other registration errors. When both fields exist, `errno` takes precedence. `catalog.integration.test.ts` exercises real Bun SQL errors from missing relations and columns.
