### Automation identifiers leaked into human displays

- **What happened:** Automation rows and dialogs showed names such as `lieferungenEintragen` instead of a readable title.
- **Root cause:** The declaration and checked manifest carried only the execution identifier, so every consumer had to use it as a label.
- **Error class:** Missing display metadata at a shared contract boundary.
- **Guard:** `checker-titles.test.ts` validates optional reviewed titles and identifier stability; Code page, access, approval, Assistant and CLI tests cover title display and identifier fallback. `admin.integration.test.ts` also checks that a decided version leaves open approvals and the waiting counts.
