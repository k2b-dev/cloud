### Subscription fan-out scanned all subscriptions while holding the event lock

- **What happened:** Event acceptance and historical catch-up scanned subscriptions sequentially as registrations grew. Gustav's SDK index also labeled AI inference Queries as ordinary reads.
- **Root cause:** Subscription indexes covered identity and consumer/key lookup, but omitted the active event/version/place filter. Catch-up joined JSON bindings without targeting the selected subscription ID. The SDK index classified only by operation kind and duplicated the checker's inference rule.
- **Error class:** Missing query-shaped indexes and classification drift between discovery and execution.
- **Guard:** `event-query-plans.integration.test.ts` seeds 12,040 subscriptions across applications, types, versions and places, then checks natural query plans without disabling sequential scans. `chat-sdk.test.ts` checks actual inference methods in the full generated catalog; `policy.test.ts` covers inference exclusions. One shared inference predicate serves authoring, the bridge and the index.
