### Recheck a chat binding at message admission

- **What happened:** A chat send could resolve a destination before a concurrent binding change and still queue there afterward. A never-bound chat sender also had no recovery entry.
- **Root cause:** Admission locked the Code row without comparing the resolved revision, while missing-chat projections required a previous binding.
- **Error class:** A mutable destination was used after its snapshot became stale, and an initial missing state was omitted.
- **Guard:** A controlled overlap test observes the owner-lock wait through `pg_blocking_pids`, changes the binding and requires a retryable refusal with no receipt or queue row. Retrying the same key produces one message at the current destination. Integration also follows revision zero through notices, attention and Waiting for you, and the SQL meter pins version reads with and without a binding.
