### For You and the channel directory had two back controls below 1024 px

- **What happened:** Opened from the archive or the Unread list, Chat's For You page and channel directory showed the shell's "‹ Chat" next to their own "Back to chats" on tablets and phones. Valentin asked on 2026-10-31 to drop top back links that are not the only way back.
- **Root cause:** The server page and the workspace island each built the title array and named the list as a level above every titled page, including the two views that draw their own back button.
- **Error class:** Shell chrome adds a way up beside a view's own back control.
- **Guard:** Both now use `chatTitle`, which gives For You and the channel directory no level above; `chat-title.test.ts` checks that and that an open chat still leads up to the archive or Unread list.
