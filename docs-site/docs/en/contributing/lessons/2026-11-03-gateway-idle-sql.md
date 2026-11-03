### Registry heartbeats rewrote unchanged application records

- **What happened:** A near-idle production measurement recorded 623 upserts of `gateway.registered_apps` per minute after release 0.63.
- **Root cause:** Gateway Ops persisted every live app on every registry notification, including lease renewals. The router also reconciled every five seconds against a 30-second presence lease.
- **Error class:** Persisting liveness as repeated content writes.
- **Guard:** `registered-apps.test.ts` counts zero SQL calls for a deterministic idle minute with 5 and 20 apps, and covers content changes, failed writes, departure and reappearance. `gateway/src/runtime.test.ts` verifies the 30-second reconciliation, presence renewal and immediate domain hints. `services/gateway.integration.test.ts` provisions the old NATS bucket first and verifies the new per-entry 90-second TTL without declaration drift.
