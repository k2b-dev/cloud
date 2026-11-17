### A live reconnect test held a credential check past its deadline

- **What happened:** The delayed identity hint regression from #3354 closed a
  valid socket with `1011 unavailable` in CI (#3594).
- **Root cause:** The test started the ten-second identity catch-up budget,
  then held its credential result until a real outbox hint crossed NATS. That
  external wait could exhaust the budget before `finishCatchup.resolve()`.
  Explicitly firing the armed ten-second timer while publication was pending
  reproduced the same close. Once released, the engine completes the held
  read and performs the third credential check; no engine deadlock was found.
- **Error class:** A test-controlled barrier keeps product work pending while
  unrelated infrastructure consumes its deadline.
- **Guard:** `live-routes.integration.test.ts` reads and buffers the real hint
  before the reconnect starts either credential deadline. It delays only the
  follower notification until the second read, then still
  requires exactly three checks, an open socket, and the full replay. The
  engine unit tests independently expire the deadline and verify fail-closed
  behavior. The reshaped regression still fails with `1013 access_changing`
  when run against the engine loop from before #3354.
