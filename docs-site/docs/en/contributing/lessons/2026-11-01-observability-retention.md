### Log retention deleted every expired row in one statement

- **What happened:** Observability history outgrew its retention period; trace history reached 68 GB in one installation (#2422). Trace retention was rebuilt in #2468; log cleanup still removed every expired `logging.entries` row with one unbounded `DELETE` and no lease heartbeat.
- **Root cause:** Retention work was sized by the backlog, not by a batch: a large backlog held locks for the whole statement and could outlive the job lease.
- **Error class:** Data-sized retention work in one statement without heartbeats or a resumable budget.
- **Guard:** `logging/retention.integration.test.ts` covers log batches of at most 10,000 rows, heartbeat progress, recent survivors, cancellation between batches, and a pass that yields at its budget and resumes on the next pass.
