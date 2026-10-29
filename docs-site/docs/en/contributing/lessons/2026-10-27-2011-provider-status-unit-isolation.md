### Provider status writes escaped adapter unit tests

- **What happened:** The model classes branch repeatedly crashed Bun 1.4.2 in the Cloud unit shard. Single-file tracing found 630 closed-port connection attempts in the provider settings tests and 330 in the retry tests without a database target.
- **Root cause:** Provider adapters gained detached status writes, but their HTTP-only unit tests did not mock the new persistence boundary. Failed status writes also used the database-backed logger, starting more failing queries. Some writes remained pending when their test file finished.
- **Error class:** Unowned asynchronous persistence across test isolation boundaries.
- **Guard:** `provider-status.test.ts` and `transcription.test.ts` hold status persistence open and check that completion, streaming, and transcription settle it before returning. Adapter unit tests mock the status service and restore their spies. Single-file tracing confirms zero connection attempts in all five affected unit files after the fix.
