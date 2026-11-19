### Immediate lock refusal defeats maintenance cancellation

- **What happened:** An eligible sole administrator could not approve a Code version while database maintenance held a conflicting lock.
- **Root cause:** `NOWAIT` refused immediately. PostgreSQL can cancel a blocking autovacuum only after the lock waiter passes `deadlock_timeout`, one second by default. The decision now waits with a two-second local lock timeout and restores the caller's timeout; lock or statement cancellation still refuses with `BUSY`.
- **Error class:** Immediate lock refusal bypasses database contention recovery.
- **Guard:** Integration tests hold a real `ANALYZE auth.users` lock until the decision queues, then require successful approval. A settings writer must still cause `BUSY` within three seconds without saving a decision. Platform tests cover timeout restoration, row locks and statement cancellation; browser tests cover localized retry and stable card geometry.
