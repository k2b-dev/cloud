### Preserve completion state when a note stops editing

- **What happened:** A delayed completion callback threw a `RangeError` after a Notebook session ended. The error could appear during a later action or test.
- **Root cause:** The editor removed its completion extension while its plugin still had timer or asynchronous result callbacks that required the extension's state field.
- **Error class:** A reactive reconfiguration removed state still owned by pending work.
- **Guard:** `sync-ended.behavior.test.tsx` checks live slash suggestions, queues another completion, ends sync, and advances frozen timers. The note stays readonly, suggestions close, and its text is preserved.
