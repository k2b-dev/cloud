### A live reconnect test counted checks instead of guarding delivery

- **What happened:** After #3595, the delayed identity hint regression still
  failed in #3594: CI observed four credential checks instead of three, while
  the socket remained open and replayed the expected event.
- **Root cause:** The test counted all credential probes during reconnect as
  exactly three. `checkConnection()` coalesces invalidations only while a
  check is pending; a later invalidation requires another fresh read. The
  shared Core follower also drains existing identity events, including global
  setting and signer changes, and rechecks listeners at startup. The test
  controls its staged hint, not every invalidation in that stream. The six
  integration shards in #3580 changed suite order and load, exposing the
  unsupported count assumption; #3580 already contained #3595 and changed no
  event code. The CI log does not identify the extra invalidation, so its
  particular source remains unconfirmed.
- **Error class:** An integration test treats an aggregate asynchronous call
  count as a delivery guarantee.
- **Guard:** `live-routes.integration.test.ts` waits for a credential read
  after the delayed hint, holds its result, and checks that no replay frame
  has escaped. Releasing it must preserve the socket and produce exactly the
  missed event followed by `ready`. The startup and catch-up barriers, real
  outbox hint, replay cursor, and deadlines stay unchanged. Engine unit tests
  independently cover revocation during catch-up and deadline expiry. A
  diagnostic extra invalidation after the next read starts produces four
  checks with the correct replay; dropping the delayed user hint makes the
  revised regression fail.
