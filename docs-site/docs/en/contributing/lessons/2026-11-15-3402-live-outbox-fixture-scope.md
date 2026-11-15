### Keep live-outbox fixtures within their schema

- **What happened:** The first live-outbox integration test timed out, leaving the remaining tests without their events table (#3402).
- **Root cause:** The test migrated all of Core before installing the events schema. Growth in unrelated domains consumed its existing five-second budget.
- **Error class:** Unrelated bootstrap work inside a bounded domain test.
- **Guard:** `packages/cloud/src/events/live.integration.test.ts` uses `installLiveOutbox(sql)` after checking the missing-schema error. Its original deadlines and all dispatcher assertions remain in place.
