### Show committed progress inside a blocked page

- **What happened:** Catch-up reported zero dispatched messages while its first run had committed and the next message waited for backlog capacity.
- **Root cause:** Sync's public dispatched count advances after a whole page completes. A partially admitted page can remain blocked until existing runs finish.
- **Error class:** Page-level progress hiding committed effects.
- **Guard:** Catch-up status counts the bounded snapshot's durable admission receipts. The integration test limits the backlog to two, checks one dispatched message with no failures, and verifies that live delivery retains its reserved capacity.
