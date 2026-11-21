### Resource ordering must preserve failed-subject holds

- **What happened:** Extending resource delivery ordering across subjects also released successors of a terminally failed event with the same subject.
- **Root cause:** The failed-predecessor predicate checked subscription kind instead of subject identity.
- **Error class:** Weakening an existing queue-ordering guarantee while adding a broader ordering constraint.
- **Guard:** The unchanged resource-delivery test in `packages/core/src/app-events.integration.test.ts` holds a same-subject successor through eight failures and releases it after explicit replay. `packages/core/src/code/events.integration.test.ts` separately checks mailbox ordering and progress for different message subjects after retry exhaustion.
