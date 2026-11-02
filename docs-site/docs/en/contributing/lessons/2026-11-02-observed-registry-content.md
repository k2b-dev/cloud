### Lease renewals amplified registry reads and runtime rebuilds

- **What happened:** Unchanged registrations rebuilt every process's runtime. Capability discovery fetched the complete KV snapshot on each call, including Core's idle timer.
- **Root cause:** App watches treated lease revisions as content changes, local writes discarded the covering watch, and capability reads bypassed the process view.
- **Error class:** Shared-state read amplification through lease invalidation and per-call snapshots.
- **Guard:** `registry-idle.test.ts` counts snapshot calls, watches, and rebuilds with 5 and 20 apps. `observed-view.test.ts` covers immutable reads, active expiry, revision fences, and failed-watch recovery. `registry-view.integration.test.ts` checks network-free app and capability reads and capability-only remote updates. The `registry-snapshots` repository rule restricts raw registry handles to writers and explicit instance readers.
- **Test boundary:** Grids checks machine authorization after app entry-rule changes arrive through the watch. Its registry cancellation test forces a transport reconnect before delaying recovery; a heartbeat must keep the view warm and cannot stand in for watch loss.
- **Liveness boundary:** Public app-registry watchers still receive renewed leases for retries and last-seen tracking. Internal runtime watchers subscribe only to content changes. Unit and real-NATS guards verify both notifications against the same heartbeat without extra reader requests or runtime rebuilds.
