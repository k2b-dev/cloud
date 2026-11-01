### Freeze the app clock at the real present when Postgres keeps real time

- **What happened:** Two Code bridge integration tests turned red for every open pull request at 12:00 UTC, with no code change.
- **Root cause:** The test froze the app clock at the fixed instant `2026-11-01T12:00:00Z`, while Postgres kept the real clock. A heartbeat computed its lease from the frozen clock, so once real time passed that instant, the database saw the lease as already expired.
- **Error class:** A hard-coded future date in a test that mixes a frozen app clock with `clock_timestamp()` becomes a time bomb.
- **Guard:** The test now freezes the clock at the real time it starts, and it passes at any time of day. No rule catches this mix yet, because a static check cannot tell which test compares the two clocks.
