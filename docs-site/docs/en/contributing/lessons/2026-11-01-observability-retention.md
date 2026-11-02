### Retention must drain abandoned work and renew its lease

- **What happened:** Trace history outgrew the configured retention period and reached 68 GB in one installation.
- **Root cause:** Cleanup excluded abandoned open spans and deleted completed spans with an unbounded cascading statement without lease heartbeats. A daily pass could stall or lose its lease; historical production run outcomes were not available to this fix.
- **Error class:** Unbounded retention work and incomplete expiry predicates.
- **Guard:** `logging/retention.integration.test.ts` exercises multiple batches, event fanout across every candidate span, abandoned spans, recent survivors, log batches, heartbeat progress and cancellation between batches.
