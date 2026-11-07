### Changing chats kept the destination composer read-only

- **What happened:** Moving to another chat while an app-opening draft save waited kept the destination composer read-only until the save finished or Escape was pressed.
- **Root cause:** Every draft-key change was treated as the opener's own move to a newly created chat.
- **Error class:** User navigation mistaken for an async action's own navigation.
- **Guard:** `chat-slash.behavior.test.ts` checks immediate cancellation on unannounced draft changes, ignores late results, and consumes `follow()` for one move. `composer-app-commands.behavior.test.tsx` checks that navigating during a save frees the destination composer before the save finishes and still allows the opener to create a plain chat.
