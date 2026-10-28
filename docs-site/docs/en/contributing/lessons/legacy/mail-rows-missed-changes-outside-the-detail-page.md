### Mail rows missed changes outside the detail page

- **What happened:** Opening a conversation with more than 100 messages could leave its unread or flagged row state stale ([#1510](https://github.com/k2b-dev/cloud/issues/1510)).
- **Root cause:** The browser inferred complete conversation state from the newest 100 message bodies and their selected placements.
- **Error class:** Complete row state inferred from a bounded detail page.
- **Guard:** The authorized detail response carries state aggregated across all messages and live placements. The 101-message HTTP and automatic-read tests cover an older unread message; comparison tests preserve folder/search scopes, recovery, and the highest revision from parallel detail reads.
