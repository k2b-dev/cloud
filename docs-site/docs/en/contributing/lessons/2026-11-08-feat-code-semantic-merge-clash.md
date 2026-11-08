### Two green pull requests can break a branch without a merge queue

- **What happened:** #2817 (Gustav rebuild) added an eval that imports `ChatTaskGrantsSchema` from `@k2b/cloud/ai`. #2856 (routines become Code) removed that export. Each pull request passed its gate on its own; after both landed on `feat/code`, the assistant typecheck failed.
- **Root cause:** `feat/code` squash-merges without a merge queue and without requiring branches to be up to date, so neither pull request was checked against the other.
- **Error class:** Two independently green changes break each other after landing, because one removes an export that the other imports.
- **Guard:** The eval is part of the `packages/assistant` typecheck, so the gate reports the break on every pull request into `feat/code`. To catch it before landing, the `feat/code` slice convention requires merging the current `origin/feat/code` into a branch and waiting for a fresh gate before auto-merge whenever another slice in the same package has landed since its last run.
