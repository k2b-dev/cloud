### Operator counts scanned old successful sync runs

- **What happened:** Reading recent sync states could scan all retained runs, including completed history outside the operator window.
- **Root cause:** One OR combined all running runs with recent terminal runs, preventing reliable use of the existing running and resource/time indexes under a generic plan.
- **Error class:** Unbounded historical scan for a bounded status window.
- **Guard:** `sync-state-counts.integration.test.ts` prepares the actual query with `force_generic_plan` against 432,000 historical rows in a migrated database. It requires the existing time index and a production partial index and exact counts for the 24-hour operator window, a one-hour window, an old running run and another mailbox. Keep disjoint running/recent branches parameterized per resource.
