### Immediate lock refusal defeats maintenance cancellation

- **What happened:** An eligible sole administrator could not approve a Code version while database maintenance held a conflicting lock.
- **Root cause:** `NOWAIT` refused immediately. PostgreSQL can cancel a blocking autovacuum only after the lock waiter passes `deadlock_timeout`, one second by default. The decision now waits for all population table locks within one two-second statement deadline, keeps `FOR SHARE NOWAIT` on the author row, and restores both caller timeouts; lock timeout, statement cancellation, or a deadlock refuses with `BUSY`.
- **Error class:** Immediate lock refusal bypasses database contention recovery.
- **Guard:** Integration tests hold a real `ANALYZE auth.users` lock past `deadlock_timeout` after the decision queues, then require successful approval. A settings writer must still cause `BUSY` within three seconds without saving a decision. Platform tests cover both timeout restorations, sequential waits on two tables, a row writer whose UPDATE overlaps the decision, and statement cancellation; browser tests cover localized retry and stable card geometry.
