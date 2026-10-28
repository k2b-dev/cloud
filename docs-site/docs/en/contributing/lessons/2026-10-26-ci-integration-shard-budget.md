### Integration growth exhausted the merge queue job limit

- **What happened:** The single integration job took 32–40 minutes and was cancelled at its 40-minute limit, blocking the merge queue.
- **Root cause:** CI ran every non-Grids integration suite serially in one job. The runner accepted integration sharding but selected unit weights, and checked its time budget only after all suites finished.
- **Error class:** Unbounded aggregate test duration exceeds the CI job budget.
- **Guard:** Three integration shards use per-suite integration timings, a 20-minute runner deadline and a 30-minute job limit. The runner tests verify exact integration coverage, predicted shard times at or below 15 minutes, the workflow budget, and deadline termination of active commands, detached descendants, and stalled NATS housekeeping. The existing `ci-gate` check requires the integration matrix to succeed.
