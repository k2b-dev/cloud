### The Assistant's sidebar listed every open chat

- **What happened:** A person with 1,000 open chats got all of them in one sidebar: one query without a limit, 6,334 elements on the page and about ten seconds until it was ready.
- **Root cause:** `listSidebarConversations` in `packages/cloud/src/ai/store.ts` read every open chat of the person; the sidebar had no other way to stop.
- **Error class:** A list the person can grow without end is read and drawn whole.
- **Guard:** The query takes at most `AI_SIDEBAR_CONVERSATIONS_MAX` (100) chats, one more when the caller asks whether more exist; the sidebar then ends in "More chats …", which opens the paged list of every chat. `packages/cloud/src/ai/sidebar-conversations.integration.test.ts` pins one statement with `scripts/fixtures/sql-meter.ts` and the bound for 120 chats.
