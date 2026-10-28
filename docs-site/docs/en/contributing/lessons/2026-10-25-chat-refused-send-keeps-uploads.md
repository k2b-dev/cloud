### A refused send discarded the uploads it should have kept

- **What happened:** In the Chat composer, a message with a failed upload was refused, but the upload was discarded, so its "Try again" did nothing.
- **Root cause:** The composer empties its chips before it hands a message over and restores them when the message is refused. A refusal that came back at once restored them only after the release check had run, so the check saw the upload as removed.
- **Error class:** Cleanup ordered by microtasks.
- **Guard:** The release waits for the current task, skips while a message is handed over, and gives up only uploads the composer still owns, never those a sent message took over. `ChatAttachments.browser.test.ts` refuses a send with a failed upload, retries it, sends both files, and checks that nothing was discarded.
