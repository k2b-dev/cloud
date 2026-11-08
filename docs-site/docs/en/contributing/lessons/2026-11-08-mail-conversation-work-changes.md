### Conversation work changes follow the triggering message

- **What happened:** The replacement Mail workflow did not preserve conversation work-state behavior for every message-link kind.
- **Root cause:** The shared collaboration service did not apply the triggering message’s current membership rule to individual and batch changes or queued replies.
- **Error class:** Losing domain invariants when replacing a workflow.
- **Guard:** `packages/cloud/src/code/bridge.integration.test.ts` carries a stored Mail occurrence through the real bridge and provider, checks individual and mixed-batch status, assignment and snooze calls, and verifies unchanged conversation state for ineligible links. `packages/mail/src/service/code-work-state.test.ts` covers the membership decision directly. `packages/mail/src/service/sent-projection.integration.test.ts` checks reply admission before a durable send or provider effect and preserves the eligible reply path.
