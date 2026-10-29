### Pulse retention confirmation and lowered policy limits

- **What happened:** A retention confirmation could delete data under settings the person had never previewed; lowering the raw retention maximum also blocked unrelated settings edits.
- **Error class:** Confirmation without a state precondition; policy validation rejects unchanged stored values.
- **Guard:** Pulse's `store/retention.integration.test.ts` checks all three stale retention periods without writes, matching confirmation, unchanged over-maximum retention, and refusal of changed values above the maximum; API and frontend error-mapping unit tests preserve the preview baseline and visible conflict error.
