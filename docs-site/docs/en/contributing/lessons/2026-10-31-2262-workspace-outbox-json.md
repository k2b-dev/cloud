### A JSON outbox must retain objects through the database boundary

- **What happened:** Workspace hints reached the broker as strings, so subscribed notebook readers received no visible updates. The retained-event test compared a string with the expected object.
- **Root cause:** Binding `JSON.stringify(event)` directly to `::jsonb` made Bun encode the string as a JSON string. Casting through `::text::jsonb` stores the intended object. An API-only test also omitted the new dispatcher lifecycle, and a settings test still expected full data instead of the reference-only hint.
- **Error class:** Database parameter encoding changes the payload shape; fixtures drift from the application lifecycle and event contract.
- **Guard:** `workspace-events.integration.test.ts` checks the stored JSON type and retained object shape. `workspace-outbox.integration.test.ts` exercises prompt socket delivery, retry, recovery, and savepoint rollback. `reading-note-edit.integration.test.ts` starts and drains the dispatcher around real API writes. `notebook-presentation.integration.test.ts` checks the committed reference-only hint and reads the saved presentation from the canonical service.
