### Migration checks must remain bounded under partial rollout and contention

- **What happened:** Legacy requests queued on one telemetry row and a hanging application could prevent migration status from returning useful evidence.
- **Root cause:** Every request wrote the shared row, and serial probes shared the server idle deadline without their own timeout.
- **Error class:** Unbounded diagnostic work on a live request path.
- **Guard:** The migration integration test holds an evidence row lock during concurrent requests and checks that a hanging application still returns JSON naming its key. Focused status tests cover per-key failures and the Core evidence capability marker.
