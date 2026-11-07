### Retiring execution must preserve historical stream isolation

- **What happened:** Finalizing a legacy routine turn could publish a completion event to the interactive chat stream after routines were retired.
- **Root cause:** Removing the routine runtime also removed the publication guard for stored routine configurations.
- **Error class:** Feature retirement removes a boundary still needed by historical records.
- **Guard:** `retired-routines.test.ts` verifies that both legacy background and mandate configurations suppress interactive completion events. Generic mandate lifecycle and approval-list integration tests use surviving workloads or archived turns. Shared HTTP policy, interactive executor and server-owned runner tests retain their generic assertions when routine variants are removed.
- **Migration boundary:** Fresh databases with no routine authority initialize AI without Core's audit schema. Actual revocations still commit with their audit events. The live-function health and map-isolation integration tests exercise this smaller startup dependency; website provenance retains its assertions against terminal legacy metadata and verifies that the turn cannot be queued again.
