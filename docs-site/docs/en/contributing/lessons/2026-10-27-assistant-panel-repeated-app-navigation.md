### The Assistant panel repeated the application's navigation and start page

- **What happened:** The Assistant side panel showed a head row with "Recent and all chats" and a maximize button, and four suggestion tiles under the composer. Both head controls led toward the full chat list, and the tiles crowded the narrow panel.
- **Root cause:** The panel reused the application's empty start page as it was and added its own navigation head, instead of deciding what a narrow companion surface needs and linking to the application for the rest.
- **Error class:** A companion surface copies the full application's navigation and start content instead of leading to the application.
- **Guard:** `packages/chat/src/frontend/ChatPanel.browser.test.ts` requires the panel to have no head row and no suggestions, and requires "All chats" in the row under the composer to take keyboard focus without moving anything and to open the application at the current chat. `AssistantEmptyChat.render.test.tsx` renders the start without suggestions.
