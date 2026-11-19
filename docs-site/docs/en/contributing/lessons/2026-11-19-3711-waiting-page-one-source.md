### The page Waiting for you showed other entries than the row and the count that lead to it

- **What happened:** The row above the field and the sidebar count said two things wait, such as "Switch on version 2" and an automation that needs a secret. The page Waiting for you also showed two entries, but a different pair: it lacked the version and listed Code of a place the person administers instead.
- **Root cause:** The page read approvals, automations and a separate Code-of-places check, while the row and the count read the person's open questions. Versions of the person's own Code were only in the open questions, and the place check was only on the page.
- **Error class:** A detail page that a count leads to collects its entries from other sources than the count, so the two agree only by chance.
- **Guard:** The page renders versions from the same `waitingQuestionsView` as the row and the count, and the separate place check is gone. `packages/assistant/src/frontend/AssistantWorkspace.waiting.behavior.test.tsx` opens the page from the sidebar with the row's data and checks that row, count and page list the same entries.
