### An event line offered to switch on a replaced version

- **What happened:** In a Gustav chat the card said "Version 1 was replaced by version 2. The approval for it is further down." Further down, the event line "Admin approved version 1" still offered "Switch on …", so the chat both offered and refused the same step.
- **Root cause:** The event line decided its action only from the chat's own messages (`packages/assistant/src/frontend/code-decision-deferred.tsx`). A newer version is a fact in Core, not always a message in this chat, so the line kept acting while the card, which reads Core's activation preview, already showed the version as replaced.
- **Error class:** Two views of the same version took their state from different sources, and the one that offers an action used the weaker source.
- **Guard:** `AssistantGustav.browser.test.ts` opens an approved version 5 whose preview says the latest is 6 and checks that the event line has no button.
