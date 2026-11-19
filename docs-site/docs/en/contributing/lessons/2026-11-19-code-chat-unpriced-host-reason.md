### An unpriced automation model appeared to have lost chat access

- **What happened:** A personal automation's chat turn stopped with a generic lost-access message instead of explaining that its model had no price. The entire reason also appeared in the notice's bold title.
- **Root cause:** Model classification reached version approval before checking whether a daily budget could apply. The resulting approval error became `not_allowed`, hiding the host's actual cause.
- **Error class:** A host rejection loses its actionable cause during generic error translation.
- **Guard:** `packages/core/src/code/chat-turn-budget.integration.test.ts` asserts `host_rejected` and localized price explanations for missing and zero prices; `packages/cloud/src/ai/chat/timeline.behavior.test.tsx` checks that the short title and detailed reason remain separate.
