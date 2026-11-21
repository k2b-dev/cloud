### Migration recovery added a read to every chat stream

- **What happened:** Authenticated chat stream admission used 14 SQL statements instead of 13, including for conversations without migrated aborted turns.
- **Root cause:** Both history readers queried migrated turns separately after loading messages. The recovery projection ran on every read even when no turn needed it.
- **Error class:** A migration display projection adds an unconditional database round trip to a hot read path.
- **Guard:** `routes.integration.test.ts` pins authenticated admission at 13 statements, live deltas and heartbeats at zero, and identity events at 12. `capability-targets-migrate.integration.test.ts` meters ordinary and empty history reads and verifies recovery notices through the stream snapshot, pagination, and unchanged stored message bytes.
