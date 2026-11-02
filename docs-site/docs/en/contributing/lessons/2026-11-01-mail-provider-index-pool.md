### Mail background lookups scanned message references and index builds shared the query pool

- **What happened:** Provider-message identity lookups filtered JSON across folder references without an expression index. Concurrent background index DDL could also queue unrelated work behind a snapshot wait.
- **Root cause:** The lookup had no index matching its literal JSON expression, and Mail used ordinary pool connections for concurrent index maintenance.
- **Error class:** Unindexed expression lookup and foreground pool starvation by background DDL.
- **Guard:** `provider-message-index.integration.test.ts` prepares the production query under `force_generic_plan` with 80,227 references across 354 folders and requires the expression index. Its blocked-build tests require four queries through a two-connection pool to finish before the old snapshot is released, for both command and provider indexes. Existing migration tests cover interrupted builds; the BM25 builder also reserves and releases its connection.
