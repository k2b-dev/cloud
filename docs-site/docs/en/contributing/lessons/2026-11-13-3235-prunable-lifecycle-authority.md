### Keep lifecycle authority outside a prunable event prefix

- **What happened:** Pruning a persisted freeze marker reopened a shared document before its lease expired; closing before a domain commit also stranded drafts after rollback.
- **Root cause:** The document log tail doubled as lifecycle authority, and terminal close was not fenced by a retryable freeze token.
- **Error class:** Retained notifications are mistaken for durable authority across pruning and transaction boundaries.
- **Guard:** `room-lifecycle.integration.test.ts` freezes and closes across two rooms, prunes both boundaries against real NATS, and verifies admission and terminal joins. Lifecycle unit tests cover rollback, expiry, stale tokens, and crashes between durable close and notification; snapshot tests prevent repair from bypassing a pruned fence.
