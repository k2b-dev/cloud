### Honor deferred publication before the first delivery attempt

- **What happened:** Fresh outbox rows with future deadlines would publish immediately, so an expiry invalidation could arrive before access expired.
- **Root cause:** The claim predicate treated every row with zero attempts as due regardless of `next_attempt_at`.
- **Error class:** A retry-only deadline assumption is reused for scheduled first delivery.
- **Guard:** `room-access-events.integration.test.ts` checks account/session deadlines through the real dispatcher, including renewal, due delivery and idempotent restart; existing outbox tests cover ordering and retries.
