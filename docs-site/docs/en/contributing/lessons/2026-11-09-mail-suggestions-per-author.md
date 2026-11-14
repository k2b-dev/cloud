### Each automated author keeps its own draft suggestion

- **What happened:** A second service account's `draft.create` in a conversation that already held Gustav's untouched suggestion got Gustav's draft back, so its own content was lost, and every automated draft was labelled "Suggestion from Gustav" (#3055).
- **Root cause:** The suggestion rule was written for one known author: the lock, the lookup and the unique index keyed only the conversation, and the label was a fixed text.
- **Error class:** A platform rule for a class of principals (service accounts) silently specialised to one member of that class.
- **Guard:** The lock, lookup and `drafts_untouched_suggestion_author_idx` include the author. `draft-suggestions.integration.test.ts` creates suggestions from Gustav and a second account in one conversation and checks two drafts with their own content and names, one draft per author on repeat, and that a person's adoption closes only one. The Mail shell suite renders another account's suggestion and checks that its name, not Gustav's, labels the draft and its row.
