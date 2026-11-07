### Retiring execution must preserve historical stream isolation

- **What happened:** Finalizing a legacy routine turn could publish a completion event to the interactive chat stream after routines were retired.
- **Root cause:** Removing the routine runtime also removed the publication guard for stored routine configurations.
- **Error class:** Feature retirement removes a boundary still needed by historical records.
- **Guard:** `retired-routines.test.ts` verifies that both legacy background and mandate configurations suppress interactive completion events. Generic mandate lifecycle and approval-list integration tests use surviving workloads or archived turns, and fresh AI fixtures run the audit migration needed to record revocations. Shared HTTP policy, interactive executor and server-owned runner tests retain their generic assertions when routine variants are removed.
