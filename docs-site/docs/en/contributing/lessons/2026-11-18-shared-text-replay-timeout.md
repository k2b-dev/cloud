### A draft must recover when the socket never becomes ready

- **What happened:** A reply could stay at “Connecting…” with retry and copy actions after a connection interruption.
- **Root cause:** The shared-text provider timed out unacknowledged publications but had no deadline for the WebSocket handshake or initial replay. Before replay-ready, typing only filled the local buffer, so it never started the publication timer. Mail also rejected saves immediately before readiness, promoting its connecting status to an error that replay-ready did not clear.
- **Error class:** Unbounded connection readiness and sticky transient error state.
- **Guard:** `packages/cloud/src/browser/shared-text-provider.test.ts` stalls handshake and replay without a close event, then checks reconnect, original input bases, stale callbacks and echo coverage. `packages/mail/src/lib/draft-document-client-session.test.ts` saves during delayed replay and checks automatic recovery after timeout with the reply intact.
