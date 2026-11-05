### Create receipt replay returned a JSON string instead of an item

- **What happened:** Retrying a keyed task creation returned a string while the original request returned an item object; browser fixtures and one capability fixture also retained the previous mutation inputs.
- **Root cause:** Pre-serialized JSON strings were bound directly as native Bun SQL JSONB parameters, which encoded them again; fixtures were not updated with assignee deltas and the title precondition.
- **Error class:** Double JSON encoding and stale contract fixtures.
- **Guard:** `service/assignees.test.ts` checks every concurrent replay, JSONB object types and reordered request keys; `api/task-mutations.integration.test.ts`, `capability-contracts.test.ts` and the item detail browser suite verify the public contracts.
