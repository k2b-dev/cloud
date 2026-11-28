### A restricted message showed attachment links in the v2 reader

- **What happened:** In the Mail v2 pilot, a message whose links a mailbox rule turns off still showed its attachments as links, without the notice that v1 shows above such a message.
- **Root cause:** v1 hid the attachments and drew the notice in its message card; the v2 reader was written from the pilot mockup and did not carry these conditions over. The download itself had no check of its own, so hiding the links was the only thing that kept the files closed.
- **Error class:** A rule that only the interface enforces: a second interface for the same data does not inherit it.
- **Guard:** The attachment service (`messages.openAttachment`, used by the download, the thumbnail and the capabilities) now refuses attachments of a message whose links are turned off, as the remote-content service already did. `security.integration.test.ts` checks the refusal and that a clear message still opens its attachments; `mail-v2.browser.test.ts` checks the notice and the missing links in the v2 reader. Both readers share the wording of the findings through `mail-security-finding.ts`.
