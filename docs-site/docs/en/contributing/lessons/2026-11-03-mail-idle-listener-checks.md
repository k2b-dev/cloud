### A connected IDLE listener asked for a folder sync every 30 seconds

- **What happened:** Each connected IMAP IDLE listener requested a sync of its folder every 30 seconds, although nothing had changed. The scheduled sync already checks every folder each minute, so a listened Inbox had three checks a minute instead of one.
- **Root cause:** The poll fallback for servers without IDLE also ran beside a working IDLE connection, as a second safety net next to the minute scheduler.
- **Error class:** Duplicate safety timers for the same repair path.
- **Guard:** `imap-push-runtime.test.ts` ("a connected IDLE listener asks for a folder sync only when it connects or gets a hint") requires one sync request in five quiet minutes; before, there were eleven. Servers without IDLE keep the 30-second poll, a disconnect or reconnect still requests a sync at once, and `mail:sync-due` still checks every folder each minute.
