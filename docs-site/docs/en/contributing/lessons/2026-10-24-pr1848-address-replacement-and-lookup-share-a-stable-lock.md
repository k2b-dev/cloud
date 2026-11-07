### Address replacement and lookup share a stable lock

- **What happened:** Saving unchanged addresses could discard a completed lookup or retain a failed claim, causing another paid lookup or delaying recovery.
- **Root cause:** Replacement read asynchronous state before locking the rows that completion would update. PostgreSQL transaction-start timestamps could also backdate a claim after waiting for a lock.
- **Error class:** Replacing child rows loses asynchronous state.
- **Guard:** Replacement, claim, completion and release lock the parent contact before reading or writing address state; provider calls run outside these transactions. Claims use statement time. `address-location.integration.test.ts` uses deterministic barriers before child-row locking and checks success, failure and lock-wait timestamps.
