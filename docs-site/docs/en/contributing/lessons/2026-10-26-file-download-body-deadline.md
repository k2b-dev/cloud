### A download deadline expired before its test observed the rejection

- **What happened:** The streaming download deadline test failed under load before its rejection assertion was attached (#1846).
- **Root cause:** An 80 ms wall-clock deadline included socket setup while the test waited for the first response before observing the download promise.
- **Error class:** Asynchronous test setup races an unobserved rejection and consumes the deadline intended for a later transport phase.
- **Guard:** The streaming-body and pre-header tests observe the outcome immediately, establish the intended transport phase, and advance a controlled clock to the unchanged 80 ms deadline. The body test receives another chunk, verifies both sides remain open at 79 ms, and checks destruction at expiry. Caller cancellation still uses the real transport and clock.
