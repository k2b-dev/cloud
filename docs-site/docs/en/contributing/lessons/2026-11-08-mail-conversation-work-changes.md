### Conversation work changes follow the triggering message

- **What happened:** The replacement Mail workflow did not preserve conversation work-state behavior for every message-link kind.
- **Root cause:** The shared collaboration service did not apply the triggering message’s current membership rule to individual and batch changes.
- **Error class:** Losing domain invariants when replacing a workflow.
- **Guard:** `packages/cloud/src/code/bridge.integration.test.ts` carries a stored Mail occurrence through the real bridge and provider, checks individual and batch status and assignment calls, and verifies unchanged conversation state for ineligible links. `packages/mail/src/service/code-work-state.test.ts` covers the membership decision directly.
