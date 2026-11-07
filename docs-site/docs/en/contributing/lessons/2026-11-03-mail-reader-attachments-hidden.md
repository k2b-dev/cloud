### A mail's attachments were easy to miss where it is read

- **What happened:** A message with dozens of photos showed only its text in the reading pane; the attachments appeared in the details panel, and in the message itself only as a long file list below the whole body.
- **Root cause:** The reader listed attachments after the body, every one as a plain row, and a collapsed message gave no sign of them.
- **Error class:** Content that exists only in a side panel or below the fold of a long body, with no cue where the person looks first.
- **Guard:** `MailConversationReader.render.test.tsx` requires the attachment list between the message header and its body, the first three with "Show all", a count in a collapsed header, and no repeat of inline images; `mail-shell-reader.browser.test.ts` checks the list is visible without scrolling on desktop and phone and that loading previews moves nothing.
