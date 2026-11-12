### A new message in Mail closed about two seconds after Compose

- **What happened:** Compose opened the new draft in the reader and in the
  list, and about two seconds later the composer closed while the URL still
  named the draft.
- **Root cause:** The workspace counted the reader's `draft` parameter as part
  of the list (`routeListKey` and `mailListScope` in
  `packages/mail/src/frontend/MailWorkspace.island.tsx`). Opening the draft
  therefore never reached the route that the list reloads, and the live
  refresh that follows the new draft committed that route without `draft`,
  which closes the new message.
- **Error class:** A URL parameter that belongs to one pane is treated as part
  of another pane's identity, so a background reload of the other pane resets
  it.
- **Guard:** `MailWorkspace.compose-open.behavior.test.tsx` test a4 opens a
  new message, sends a live event, and expects the composer, its list row, and
  `?draft=` to remain after the reload.
