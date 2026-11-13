### Use the same safety predicate before and after an irreversible migration fence

- **What happened:** F6 could write its incompatible schema marker and then refuse to consolidate a draft with an active queued submission. Earlier Mail images then refused startup too.
- **Root cause:** Preflight and ranking inferred committed sends from draft lifecycle state, while the deletion guard checked every active outbox submission. The predicates disagreed when a queued submission belonged to a draft still in `draft` state. Count validation and retirement content parsing could also fail after the fence.
- **Error class:** Incomplete preflight before an irreversible compatibility boundary.
- **Guard:** `one-reply-draft.integration.test.ts` covers draft-state scheduled and undo-window submissions, duplicate active-send refusal without marker 4 or deletions, counter validation before the marker, malformed legacy content and unloadable quote retirement, and restart after injected lock timeouts following a committed 100-deletion batch and before the final completion marker. Preflight and ranking share one committed-send predicate; retirement does not render content that will be erased.
