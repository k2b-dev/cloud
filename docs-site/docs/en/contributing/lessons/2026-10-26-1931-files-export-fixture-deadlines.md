### Bulk storage setup exceeds a hook deadline

- **What happened:** Inserting 100,000 indexed rows in one hook can leave its seed running after the hook fails. A cancellation check based on truncated query text can also miss the intended blocked query.
- **Root cause:** The oversized fixture hook exceeds its deadline, and truncated query text does not reliably identify its blocker.
- **Error class:** Fixture setup outlives its owning hook or cancellation targets the wrong query.
- **Guard:** Files `service/activity-export.integration.test.ts` prepares boundary fixtures in bounded hooks, owns and cancels seed connections, and observes its exact blocker with `pg_blocking_pids`. The 100,000/100,001-row export and blocked-count cancellation tests preserve production indexes, full export boundaries, and existing deadlines.
