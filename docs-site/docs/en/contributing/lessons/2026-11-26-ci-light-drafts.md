### Draft CI exhausted the runners needed by the merge queue

- **What happened:** Frequent pushes to draft pull requests queued full CI matrices, leaving merge queue runs waiting until ready pull requests timed out of the queue.
- **Root cause:** The pull request workflow scheduled the same full job graph for drafts and ready pull requests.
- **Error class:** CI capacity contention between draft feedback and merge validation.
- **Guard:** The `ci-gate` check requires heavy jobs to use only the draft condition and existing path filters. Its tests execute the gate shell for light and full job results, require draft gates to stay red, and check the draft, ready, merge group, manual, trigger, and concurrency policies.
