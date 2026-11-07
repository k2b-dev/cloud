### Task writes lost concurrent intent and duplicated retries

- **What happened:** Independent assignee edits replaced each other, stale title edits overwrote newer text, and retrying creation after a lost response created another task.
- **Root cause:** Assignment writes carried complete stale sets, title writes had no precondition, and task creation had no receipt committed with the task.
- **Error class:** Lost updates and duplicate effects across concurrent or uncertain writes.
- **Guard:** Spaces service tests in `service/assignees.test.ts`, REST tests in `api/task-mutations.integration.test.ts`, and input tests in `task-mutations.test.ts` cover concurrent deltas, stale-title conflicts, actor-scoped replay and expiry.
