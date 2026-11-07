### Event failures must keep bounded retries and ingestion progress

- **What happened:** Handler timeouts refunded attempts, deterministic ingestion errors blocked later events, and old redeliveries expired immediately.
- **Root cause:** Every fetch rejection was treated as an unreachable subscriber; acceptance threw on invalid input and compiled schemas; retention used the original creation time.
- **Error class:** Failure classification and recovery clocks did not match the retry and retention contracts.
- **Guard:** `packages/core/src/app-events.integration.test.ts` covers timeout/reset exhaustion, connect refusal, poison input, stored schema failure, registry outages, retirement, unchanged-row locking, renewed retention, recovery wakeups, periodic gap accounting, and rejection status. `packages/cloud/src/api/app-event-delivery.test.ts` checks that the subscriber answers its own timeout even when a handler ignores cancellation. API and CLI event tests verify rejection metadata without payloads.
