### Pulse fixture rows disappeared once ClickHouse's clock passed their retention

- **What happened:** From 2026-11-16 12:00 UTC, Pulse write-identity tests read no state change or event right after a successful write. Only tests that had not stopped merges failed, and only when ClickHouse merged the part before the test read it.
- **Root cause:** Pulse fixtures write at the frozen fixture clock, 2026-10-17 12:00 UTC, and bases keep raw data for 30 days. The fixture store already ran read views on that clock, but ClickHouse evaluates table TTLs on its own wall clock. After 30 days, any background merge deleted the rows the test had just written.
- **Error class:** A test freezes its own clock but leaves another clock in the system under test, so the test starts to fail on a calendar date.
- **Guard:** The Pulse fixture store shifts every TTL by the distance between the ClickHouse clock and the fixture clock, and it fails on a TTL it cannot shift. `packages/pulse/src/store/retention.integration.test.ts` forces a merge and checks that fixture rows expire by the fixture clock on any date.
