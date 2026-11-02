### A discarded query.cancel() promise failed a cancelled operation

- **What happened:** On Bun 1.4.4, the nonce cleanup test failed with `PostgresError: Query cancelled` although the cleanup itself stopped as intended.
- **Root cause:** Since Bun 1.4.4, `query.cancel()` really cancels, and it returns a promise that rejects with the cancellation. The abort handlers discarded that promise, so nothing handled the rejection.
- **Error class:** A floating promise from a call that used to do nothing.
- **Guard:** `app-bootstrap.integration.test.ts` fails on an unhandled cancellation. Every `query.cancel()` caller now handles the promise, and the awaited query still reports the cancellation.
