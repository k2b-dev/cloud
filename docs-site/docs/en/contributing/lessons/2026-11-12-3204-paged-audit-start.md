### A paginated audit needs a stable writer boundary

- **What happened:** A completed paginated audit could report clean counts while a concurrent insert behind its cursor remained unexamined. A failing owner could also prevent later owners from receiving a turn.
- **Root cause:** Readiness compared the scan's completion time with a writer transition, and owner scheduling advanced only after successful work.
- **Error class:** Certifying a paginated scan without a stable writer boundary, and starving independent maintenance work after a failure.
- **Guard:** `secret-owners.test.ts` inserts behind an active cursor across a writer transition and checks independent owner retries. `secret-status.test.ts` requires a completed pass to start strictly after the latest transition plus the instance lease TTL.
