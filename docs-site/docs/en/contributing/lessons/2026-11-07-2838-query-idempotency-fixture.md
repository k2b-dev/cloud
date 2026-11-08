### Action context leaked an idempotency key into Query tests

- **What happened:** The chat-run approval and daily-budget integration tests received `IDEMPOTENCY_KEY_NOT_ALLOWED` when reading the waiting state or calling text generation.
- **Root cause:** Both Query invocations reused a context containing the required chat-run Action idempotency key. Queries reject that key before dispatch.
- **Error class:** Reusing transport metadata across operations with different contracts.
- **Guard:** Query calls in the chat-run integration fixture omit the Action key. Existing waiting-state, retry, and generation assertions remain intact; the capability framework tests separately enforce Query rejection of idempotency keys.
