### Application restarts cancelled durable event backlogs

- **What happened:** Restarting a subscriber cancelled its pending deliveries, while events ingested during the restart had no delivery for it. Publisher restarts also delayed ingestion.
- **Root cause:** The broker used the live registry snapshot as the authority for durable event declarations and subscription removal.
- **Error class:** Ephemeral discovery state used as durable lifecycle state.
- **Guard:** `packages/core/src/app-events.integration.test.ts` covers offline publishers and subscribers, explicit manifest removal, bounded registration retries, exhausted claims, subscription audit transitions, dead-letter progress, actual JetStream eviction, and audited gap acknowledgement. Files provisioning tests cover area changes and live identity reconciliation before provisioning.
