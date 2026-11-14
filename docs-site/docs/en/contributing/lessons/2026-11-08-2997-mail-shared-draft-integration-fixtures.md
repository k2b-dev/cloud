### Shared draft tests must reach the failure they claim to exercise

- **What happened:** Mail's integration tests failed before checking rollback,
  failed projection, or the socket's stable stream-full error.
- **Root cause:** Fixtures passed an internal UUID to a public short-ID schema,
  expected a removed mailbox lock, used a shared-stream watermark as a tenant
  publication precondition, and mocked a topic handle that admission never used.
- **Error class:** Integration fixtures drifting from identity, concurrency, and
  dependency lifecycle contracts.
- **Guard:** The lifecycle integration test validates the public short ID before
  passing the resolved UUID to services and injects a projection failure after
  real admission. The obsolete lock expectation is removed. The socket test
  intercepts publication on the handles admission actually creates, requires the
  stable error within a bounded wait, and retries the same local update bytes.
