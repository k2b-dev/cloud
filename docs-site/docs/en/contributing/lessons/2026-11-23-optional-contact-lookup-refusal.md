### A refused optional contact lookup looked like an outage

- **What happened:** Mail asks the contact apps for optional hints: the contacts of a conversation, related mail of a contact, and attachment hints in the composer. When the person may not use a contact app, the app answers 403. Mail treated that like an outage: the conversation side panel showed contacts as unavailable, related mail answered 503, and the composer's attachment hints failed when every contact app refused.
- **Root cause:** The lookups knew only "answered" and "failed". A refusal is an answer: this person has no matches there.
- **Error class:** An optional cross-app lookup that turns a permission refusal into an error state.
- **Guard:** `conversation-context.integration.test.ts` checks that a 403 from the contact lookup gives "ready, no matches" in the side panel and 404 for related mail, while a 503 stays unavailable and 503. `mail-attachment-context.test.ts` checks that contact apps refusing the person give no hints instead of an error.
