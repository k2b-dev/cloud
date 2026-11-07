### A listened folder was checked three times a minute

- **What happened:** A connected IMAP IDLE listener requested a sync of its folder every 30 seconds, although nothing had changed, and the scheduled sync checked the same folder each minute. A listened Inbox had three checks a minute.
- **Root cause:** Two independent safety nets covered the same folder: the listener's timer and the minute scheduler.
- **Error class:** Duplicate safety timers for the same repair path.
- **Guard:** `imap-push-runtime.test.ts` ("a connected IDLE listener checks its folder once a minute besides its hints") requires six sync requests in five quiet minutes (eleven before). The scheduler test in `remote-changes.integration.test.ts` requires the minute scheduler to skip a folder whose sync was requested within the last 75 seconds and to take it back once requests stop. Review rejected two earlier drafts: removing the listener check relied on a scheduler capped at 500 folders a minute, and skipping folders by listener heartbeat trusted a heartbeat that does not prove a check ran. The skip now depends only on a recent sync request.
