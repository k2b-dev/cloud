### Assignment conflicts must return the person and time of the later change

- **What happened:** A rejected Mail assignment undo returned only an error code. The client could not replace its stale row or explain who changed the assignment and when.
- **Root cause:** Conflict responses omitted the current audit item, and undo metadata reused the undo actor when a person changed an assignment after undo.
- **Error class:** Mutation conflict responses omit authoritative reconciliation state.
- **Guard:** `automation-log.integration.test.ts` verifies persisted undo timestamps, latest manual-change attribution, complete undo and redo conflict items, and unknown attribution for historical entries and deleted conversations.
