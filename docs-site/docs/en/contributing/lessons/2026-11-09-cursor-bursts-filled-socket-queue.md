### Cursor bursts filled a connection's message queue

- **What happened:** While someone dragged a selection in Notebooks or a shared Mail draft, the document socket closed with `BACKPRESSURE` (1013), although the server itself was not busy.
- **Root cause:** Each socket handles its messages one after another, and every cursor message checked the session and access and then published to the broker. A drag sends cursor messages faster than that work completes, so the per-connection queue reached its limit of 200 and the socket was shed. Edits waited in the same queue.
- **Error class:** A last-state-wins stream (cursor awareness) was queued like an ordered command stream and shared its limit with durable edits.
- **Guard:** `packages/notebooks/src/ws-awareness.test.ts` floods a socket with cursor messages behind a slow access check and requires that it stays open, edits arrive in order, and no cursor overtakes an edit sent before it; `packages/mail/src/api/draft-document-socket.integration.test.ts` does the same for Mail drafts.
