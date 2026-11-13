### Live delivery repeated database decisions after a cache expired

- **What happened:** A channel with a one-statement access decision ran one SQL statement again on the first delivery after every two-second cache window.
- **Root cause:** Delivery expired authorization decisions, and a periodic sweep also reloaded credentials and channel access.
- **Error class:** Database-backed authorization in a live delivery hot path.
- **Guard:** `events/live-budget.integration.test.ts` pins setup to one statement and delivery to zero at +1, +2001, +4002, and +60001 ms. Event-driven revocation tests and DATA-13 require access events instead of polling.
