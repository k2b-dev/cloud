### Receipts have no client state owner

- **What happened:** A client waits for an event the service intentionally does not send, or ignores a continuation.
- **Root cause:** Receipts have no client state owner.
- **Error class:** Receipts have no client state owner
- **Guard:** Tests: Chat store applies system HTTP read/unread receipts, follows All-thread cursors, and keeps ordinary receipts on their personal channel.
