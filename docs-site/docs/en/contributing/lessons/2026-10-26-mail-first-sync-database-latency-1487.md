### Mail first-sync database latency (#1487)

- **What happened:** First sync repeated database work for newly inserted messages.
- **Error class:** Redundant reads after a confirmed insert.
- **Root cause:** New content followed the same update and lookup path as existing copies. The insertion result now distinguishes a new row from an upsert conflict; only a new row skips the redundant update and four reads. Remote-reference races fall back to the full path.
- **Guard:** The PostgreSQL integration imports 200 envelopes through `ingestEnvelope`, counts commands at the wire, and replays the batch to verify stable IDs, conversation count and read state.
- **Measurement:** On the same local test database, the original path used 4,602 commands and 4,554 ms (44 messages/s); the fixed path used 3,602 commands and 3,641 ms (55 messages/s). Command count fell 22%; timings are observations on a shared host, not a guaranteed throughput target. Batch limits and lease scheduling are unchanged.
