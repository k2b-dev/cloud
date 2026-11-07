### Suppressed updates lost the final persisted note change

- **What happened:** Saving then locking a note inside the leading event window never announced the final state; ordering could announce every renumbered sibling.
- **Root cause:** A leading timestamp discarded suppressed changes without a durable pending marker, and sibling storage maintenance reused the domain event helper.
- **Error class:** Lossy coalescing and unbounded event fan-out.
- **Guard:** Producer integration tests cover save-then-lock trailing delivery, SQL marker rollback, bounded concurrent sweeps, locked-row skipping, maximum delay, restore and anchoring paths, and moves/reset-order without sibling events.
