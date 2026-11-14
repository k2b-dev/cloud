### Print-media emulation skipped the transition that refreshes the note

- **What happened:** The Notebooks print-copy browser test intermittently exhausted its 30-second budget waiting for fresh note text after returning to print media (#1558).
- **Root cause:** Chromium can coalesce rapid screen → print emulation before delivering a media-query change. A browser probe reproduced the missing screen event and stale copy. The test also measured 150 paragraphs through sequential protocol calls, consuming unnecessary time under load. The product renders on `beforeprint` or entry into print media; its typing debounce only warms diagrams.
- **Error class:** Browser automation completion mistaken for delivery of a browser event.
- **Guard:** `note-print-copy.browser.test.ts` observes each delivered media-query transition before requesting the next one, waits for the rendered print region and fresh text, and reads all print geometry in one browser task. Its 30-second timeout stays unchanged.
