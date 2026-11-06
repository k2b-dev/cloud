### Pulse pooled transactions and durable seals

- **What happened:** Concurrent scrapes exhausted the SQL pool; pruning hour rows let retention extensions reopen sealed history; an unkeyed retry error promised duplicate prevention; host disk measurements leaked between integration suites.
- **Root cause:** A scrape retained a transaction while ingest reserved another connection, store settings and notification lookups could do the same, seals lived only in pruned rows, retry guidance assumed a key could apply retroactively, and fixtures shared instance health.
- **Error class:** Pool starvation; lost durable invariants; misleading retry recovery; environment-dependent test contamination.
- **Guard:** Pulse's two-connection scrape regression, pruned-seal/clear regression, exact partial-write error assertion, injected disk-query fixture guard, and poisoned-health fixture reset regression.
