### Archiving a chat that waited for a decision asked to stop a response

- **What happened:** A chat could not be archived and answered "Stop the current response …", although nothing ran: after a stop, the queue had started the next message as a turn that now waited for an approval.
- **Root cause:** The archive route and the chat editor knew only one reason a turn holds a chat, a running response, and the editor checked it only for the open chat.
- **Error class:** A blocking state collapsed into one message that names the wrong action.
- **Guard:** `routes.integration.test.ts` archives a chat with a running and with a waiting turn and expects the matching message; `archive-blocker.test.ts` covers every run state the chat list knows.
