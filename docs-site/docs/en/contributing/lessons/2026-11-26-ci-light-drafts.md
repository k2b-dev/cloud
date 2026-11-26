### Draft CI exhausted the runners needed by the merge queue

- **What happened:** Frequent pushes to draft pull requests queued full CI matrices, leaving merge queue runs waiting until ready pull requests timed out of the queue.
- **Root cause:** The pull request workflow scheduled the same full job graph for drafts and ready pull requests.
- **Error class:** CI capacity contention between draft feedback and merge validation.
- **Guard:** The `ci-gate` check requires heavy jobs to exclude draft PRs and keeps their extra skip allowance confined to actual draft events. Its tests execute the gate shell for light and full job results and check the draft, ready, merge group, manual, trigger, and concurrency policies.
