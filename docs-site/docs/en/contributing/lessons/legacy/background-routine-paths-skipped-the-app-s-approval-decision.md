### Background routine paths skipped the app's approval decision

- **What happened:** Routine tools executed Actions after checking a mandate without calling the app's review. Background Code Mode reviewed before an explicit mandate check and then ran even when the review supplied no scope.
- **Root cause:** The interactive approval path owned the review gate, while the two background paths treated mandate authorization as sufficient for execution.
- **Error class:** Approval gate skipped on a second execution path.
- **Guard:** `background-review.test.ts` checks mandate-first ordering and refusal on missing scope, missing review, errors, and cancellation. `capabilities.test.ts` and `capability-runtime.test.ts` assert that refused calls never execute or invoke the app. Both paths call one shared `authorizeBackgroundAction`; task and notification integration tests preserve `needs_approval` and the action name even after a completed model reply.
