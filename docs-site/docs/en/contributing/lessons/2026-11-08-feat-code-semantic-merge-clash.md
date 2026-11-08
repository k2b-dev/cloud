### Two green pull requests can break a branch without a merge queue

- **What happened:** The rebuild eval from #2817 imported `ChatTaskGrantsSchema`, which #2856 removed while retiring routines. Both pull requests were green on their own and landed on `feat/code` one after the other, so the branch stopped type-checking.
- **Root cause:** `feat/code` squash-merges without a merge queue and without requiring the branch to be up to date, so a pull request is never checked against the changes that land just before it.
- **Error class:** A semantic conflict between two independently green changes on a branch that does not re-run the gate on the merge result.
- **Guard:** The assistant typecheck in the `gate` catches the next occurrence after landing; the release-preventing guard is to merge `origin/feat/code` into a slice branch and re-run its gate whenever another slice touching the same package lands first (driver convention for `feat/code`).
