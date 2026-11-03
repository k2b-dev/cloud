### A listened folder was checked three times a minute

- **What happened:** A connected IMAP IDLE listener requested a sync of its folder every 30 seconds, although nothing had changed, and the scheduled sync checked the same folder each minute. A listened Inbox had three checks a minute.
- **Root cause:** Two independent safety nets covered the same folder: the listener's timer and the minute scheduler.
- **Error class:** Duplicate safety timers for the same repair path.
- **Guard:** `imap-push-runtime.test.ts` ("a connected IDLE listener checks its folder once a minute besides its hints") requires six sync requests in five quiet minutes (eleven before). The scheduler test in `remote-changes.integration.test.ts` requires the minute scheduler to skip a folder whose listener has a heartbeat younger than a minute and to take it back after that. The listener keeps its own check because the scheduler queues at most 500 folders a minute and cannot promise every folder a check each minute. A first draft removed the listener check and relied on the scheduler alone; review caught it.
