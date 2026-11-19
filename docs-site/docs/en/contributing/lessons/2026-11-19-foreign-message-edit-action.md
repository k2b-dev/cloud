### A message the person did not write offered "Edit and send again"

- **What happened:** On the Gustav preview (tour round P3), an automation's message showed the pencil "Edit and send again"; on a phone it stayed visible. The "My apps" card of a Code Gustav was still writing read only "Automation".
- **Root cause:** The chat offered editing for every user-role message once a retry handler existed; it never asked who wrote it. The card treated "no version yet" and "Core could not say" alike and fell back to the generic word.
- **Error class:** An action or a sentence keyed on a message's role or on a missing value instead of on its writer or on what is known.
- **Guard:** `queue-history.render.test.tsx` renders the person's own message, an automation's, another chat's and a Code-started one, and requires the edit action only on the first. `code-summary.test.ts` and `AssistantCodeView.render.test.tsx` cover a draft without a version ("No schedule yet") apart from a read Core refused.
