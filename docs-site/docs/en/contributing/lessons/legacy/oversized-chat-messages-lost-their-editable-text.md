### Oversized Chat messages lost their editable text

- **What happened:** Chat queued messages over 20,000 characters and cleared the composer. Every retry failed, and discarding the failed message lost its text ([#1184](https://github.com/k2b-dev/cloud/issues/1184)).
- **Root cause:** Only the server checked the message body; the browser consumed the draft before checking whether it could be accepted.
- **Error class:** Input consumed before deterministic validation.
- **Guard:** The composer validates with the API’s `MessageBodySchema` before queuing or consuming the draft. Chat behavior and desktop/phone browser tests submit oversized ASCII and emoji, check preserved text and visible correction feedback, then repair and send at the code-point limit; the behavior test also covers an unsupported null character.
