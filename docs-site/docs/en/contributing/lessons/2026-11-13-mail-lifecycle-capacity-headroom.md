### Size cumulative lifecycle storage and warn before it fills

- **What happened:** Shared Mail drafts became the default while their lifecycle authority still had a 16 MiB budget. Closed entries accumulate, so a sufficiently busy installation eventually cannot complete new lifecycle transitions.
- **Root cause:** The fixed budget did not account for cumulative sends, and health inspection ignored lifecycle streams because they have no Sync owner metadata.
- **Error class:** Capacity exhaustion in a non-expiring coordination store without usage warnings.
- **Guard:** Mail lifecycle-capacity integration tests measure representative entry storage, expand the old budget during readiness and preserve larger operator limits. The Mail retention suite verifies startup prepares lifecycle storage. NATS inventory, filtering and operational-health tests cover the 80% warning, installed limits, namespace isolation and recovery. Closed entries remain retained; safe retirement is tracked in #3254.
