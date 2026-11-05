### Resolve access names after the grant transaction

- **What happened:** Concurrent Skill operations exhausted the connection pool and timed out.
- **Root cause:** Grant creation and manager checks resolved display names while holding their transaction connection; the resolver requested another pool connection.
- **Error class:** Nested pool acquisition starves transactions under concurrency.
- **Guard:** The Skill pool-saturation integration test covers create, grant, recovery grants and access lists. Internal grant reads stay on their transaction; public results resolve names after commit. A deterministic resolver test covers rejected and stalled registry reads and the generic Code label.
