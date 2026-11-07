### An integration shard ran out of budget while its prediction looked fine

- **What happened:** `integration (2)` stopped at its 20-minute budget during a Venue test that had just started. The pull request in that run did not touch Venue. The shard's prediction was 12.1 minutes.
- **Root cause:** The shard's suites took 19.7 minutes. 50 integration suites had no measurement and counted as the median, and `@k2b/cloud-app-filesv2` took 479.9 s against a weight of 244.1 s. The same drift as in lesson `2026-11-01-unit-shards-at-their-time-limit`.
- **Error class:** A shard's slow growth stays invisible while it is green, because the shard test only reads the committed weights.
- **Guard:** The runner now writes a warning annotation when a shard finishes above the 15-minute target, with the refresh command. A runner test covers the warning. Nothing pushes that warning to a person yet, so it only helps someone who reads a green run or a script that checks its annotations.
