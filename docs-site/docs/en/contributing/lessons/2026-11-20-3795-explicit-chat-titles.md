### An explicit chat title was treated as an automatic default

- **What happened:** The first message or background enrichment replaced the title chosen through `ai.chat.create` or HTTP creation.
- **Root cause:** The shared creation service inserted the title without its source, leaving `title_source` at `default`. The CLI worked around this with a separate rename.
- **Error class:** Persisted user input loses its ownership metadata at creation.
- **Guard:** `ai-chat-create.integration.test.ts` creates, sends, and enriches a titled chat; `routes.integration.test.ts` checks explicit and omitted HTTP titles. Create behavior tests cover the shared 120-character limit, invisible-only rejection, direction controls, and emoji joiners.
