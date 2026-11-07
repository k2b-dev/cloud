### Code run queries need the event receipt schema

- **What happened:** Two Code data integration cases failed with a missing `code.run_requests` relation when listing runs through the public Query.
- **Root cause:** The run-list Query gained event delivery metadata that joins scheduling receipts, but its fixture installed only the identity, event and base Code schemas. The scheduling migration owns the missing table.
- **Error class:** A service gains a database dependency while an integration fixture retains an incomplete schema.
- **Guard:** The Code data integration fixture now applies the scheduling migration before creating runs. Its public Query authorization test also asserts an empty event delivery list for Code without deliveries.
