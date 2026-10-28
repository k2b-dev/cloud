### Pulse predecessor retention and source keys

- **What happened:** Lagging counter corrections selected their own old hourly value; sparse counters lost predecessors when hourly values expired before raw samples; concurrent source-key operations could exhaust the SQL pool.
- **Root cause:** The raw lookup floor exceeded the target hour, historical lookup assumed rollups outlived raw samples, and credential services or orphan-store settings reserved another connection inside a transaction.
- **Error class:** A predecessor lookup ignores retention boundaries; nested reservations starve the SQL pool.
- **Guard:** Pulse's lagging-hour and shorter-rollup-retention integration tests, two-connection source-key regression, lifecycle-change revocation tests, and orphan-deletion settings boundary unit test.
