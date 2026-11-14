### Keep terminal reasons consistent across repeated checks

- **What happened:** The individual Mail socket integration run returned `RESYNC_REQUIRED` instead of the expected `ACCESS_DENIED` when a draft moved during revalidation. Both responses closed the socket, but they gave different recovery instructions.
- **Root cause:** The room checked access before loading the document, then mapped every failed document read to a synchronization error. A move between those two checks returned a different terminal reason from a move before both checks.
- **Error class:** Repeated checks discard the more recent failure's meaning.
- **Guard:** The existing draft-moved WebSocket test in `draft-document-socket.integration.test.ts` now moves the draft inside the document-read boundary and still requires `ACCESS_DENIED`. The room preserves denied/not-found read failures without adding another query.
