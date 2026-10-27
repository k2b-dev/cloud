### AI dry-run uncertainty removed ordinary planned outputs

- **What happened:** Grids certification failed because a document validation preview lost its expected `output: null`.
- **Root cause:** The shared dry-run port stopped supplying a null output for every planner that omitted it, while only AI planners needed unavailable outputs.
- **Error class:** Broadening a special case changes an existing shared outcome contract.
- **Guard:** `executor.test.ts` verifies that declared planners retain `output: null` for omitted and explicit null outputs, including validation issues. Mail preview tests guard AI uncertainty, call ranges, and stopping at AI.
