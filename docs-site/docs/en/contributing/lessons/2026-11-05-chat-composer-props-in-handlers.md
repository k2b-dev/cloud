### Sending from a chat composer created computations that were never disposed

- **What happened:** After every send, the browser logged "computations created outside a `createRoot`" sixteen times in the Assistant part of the Cloud app, and the web Assistant passes the same kind of props.
- **Root cause:** `ChatComposer` read `props.state`, `props.disabled`, `props.submitDisabled` and `props.dictation` from its send handler and from the send button's tooltip. A host passes them as conditional expressions, which Solid compiles into getters that create a computation on each read; outside an owner that computation leaks.
- **Error class:** A component reads a host's props from an event handler or an async continuation instead of from a memo created in its own owner.
- **Guard:** `chat-composer-conversation.behavior.test.ts` "sending reads the host's props only inside the composer's owner" fails when a send reads these props without an owner.
