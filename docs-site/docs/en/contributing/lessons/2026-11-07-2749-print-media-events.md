### Await print media events between browser test transitions

- **What happened:** The notebook print-copy browser test timed out waiting for updated content after switching from print to screen and back.
- **Root cause:** Playwright's media emulation returns before Chromium delivers the media-query change event. Rapid transitions can coalesce, leaving the print listener without a new event.
- **Error class:** A browser test treats a requested media state as an observed media transition.
- **Guard:** `note-print-copy.browser.test.ts` observes each real print media event before requesting the next transition, while retaining the stale-content and independent `beforeprint` assertions.
