### Pulse state replay and reservation identity

- **What happened:** A pending batch lost its state history after a newer batch succeeded; reusing an expired key replaced earlier events.
- **Root cause:** State decisions rolled back after external inserts and retries recomputed them against newer registry values. Row IDs omitted the reservation's stored acceptance time.
- **Error class:** A rollback loses evidence of an external write; reused keys collide across reservation lifetimes.
- **Guard:** Pulse's state-plan retry and pre-insert commit integration tests, expired-key event integration test, and reservation identity unit test.
