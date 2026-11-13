### Bind late shared-text publish results to their original document

- **What happened:** A publish finishing after admission ended could replace another document's room base, snapshot and confirmed cursor when the client had switched documents.
- **Root cause:** The callback read the current connection state instead of checking its original stream and base. Writer bases compared only restore revisions, which different documents can share.
- **Error class:** A late asynchronous result mutates a newer resource owner with a coincidentally equal generation.
- **Guard:** The room captures and checks its stream, base and document; cancelled admission skips the applied callback; writer bases check document identity on merge, commit and delivery. A real-NATS stalled-owner regression detaches the caller at the unchanged five-second admission deadline, opens another document with the same generation and verifies its snapshot and cursor remain unchanged and subsequent edits cost zero SQL. A unit test rejects foreign-document merges and commits.
