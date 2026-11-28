### A restricted message showed attachment links in the v2 reader

- **What happened:** In the Mail v2 pilot, a message whose links a mailbox rule turns off still showed its attachments as links, without the notice v1 shows above such a message.
- **Root cause:** v1 hid the attachments and drew the notice in its message card. The v2 reader was written from the pilot mockup and did not carry these conditions over. Only the interface kept the files closed: the services that hand out the bytes had no check of their own, except remote content.
- **Error class:** A rule that only one interface enforces: a second interface, or any other way to the same bytes, does not inherit it.
- **Guard:** The services refuse the bytes with the stable code `ATTACHMENTS_BLOCKED` (403). Each one reads the rule through `security.ts` (`messageLinksDisabled`):
  - `messages.openAttachment`: the download, inline images, the thumbnail and the capability read. A stream checks the rule when it opens and before its last chunk; each chunk in between keeps only the access check.
  - `message-inspector`: the source preview and the `.eml` download.
  - `drafts`: a forward or "Use as new" leaves the attachments out of the draft.
  - `attachment-links`: no new public link for such a message. Once its message is restricted, an existing link answers exactly as a deleted one at every public step: the page, the unlock, the password form and a range request (404, the same body, no cookie, no grant).
- **Intended:** The text extracted from attachments and the search snippets stay readable, like the message's own text.
- **Tests:**
  - `security.integration.test.ts` covers the refusals, the clear message, the copies into a draft, and the statement pin of a three-chunk download (two rule checks).
  - `attachment-links.integration.test.ts` covers the public link at every public step.
  - `mail-v2.browser.test.ts` covers the notice and the missing links in the v2 reader.
- **Shared wording:** Both readers take the findings' words from `mail-security-finding.ts`. They hide "Download EML" and the "include attachments" choice for such a message. A forward of it says in one line that the attachments of the original are not included.
