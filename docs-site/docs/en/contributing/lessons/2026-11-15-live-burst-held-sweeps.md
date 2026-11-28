### A held sweep intercepted its own recovery timer

- **What happened:** The collection-refresh burst test stalled after releasing its held sweep, failing unrelated CI changes with `Condition not reached`.
- **Root cause:** The test intercepted every deferred sweep but saved only the latest callback. Releasing a sweep while the bounded refresh was still running allowed that refresh to schedule another sweep, which the proxy held indefinitely. The engine already coalesces pending sweeps into one timer; production timers continue normally.
- **Error class:** Timer interception outlives the test phase it controls and blocks subsequent asynchronous recovery.
- **Guard:** `collection refresh defers sustained domain bursts without closing sockets` holds the fourth discovery call behind a promise, releases every held callback with further interception disabled, and checks one pending sweep, the subsequent sweep, continued discovery, an open socket, and event delivery. The forced ordering fails with the old proxy without increasing a timeout.
