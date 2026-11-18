### The composer showed a different signature than the one Mail sends

- **What happened:** An HTML draft showed its signature as the text alternative: the logo's alt text instead of the
  image, links as `[tel:…]` and `[https://…]`, no divider, and the mailbox design's small grey footer in normal
  size. The sent message showed the signature correctly.
- **Root cause:** `MailInlineSignature` read only `text` from `POST /mailboxes/:id/compose-signature` and showed it
  with `white-space: pre-wrap`. That endpoint renders a fragment without outgoing styles or images, while sending
  renders the signature through `renderComposeContent` with the mailbox design and the logo.
- **Error class:** A preview that renders through its own path drifts from the output it stands for.
- **Guard:** The endpoint now returns `mailHtml` from the send renderer with an empty text, and the composer shows it
  in the reader's message document. `compose-signature.test.ts` and the compose-templates integration test compare
  it with the signature block of the sent HTML; the Mail shell drafts browser cases compare the shown markup, logo,
  links and footer styles with the sent HTML.
