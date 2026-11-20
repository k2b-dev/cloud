### A Code reply draft must be as sendable as a person's reply

- **What happened:** A reply that mailbox Code created with `draft.create` (only a body, as in the shipped `mail-automation.md` template) had no recipients and an empty subject. The person could not send it as it was. Mail also named the Code by its account key, for example "Suggestion from code:mail.mailbox:S2Jr6D".
- **Root cause:** The seed derived the reply's recipients and "Re:" subject, but the capability saved the caller's raw content over it. Mail read `auth.service_accounts.name`, which is a technical owner key for Code accounts, instead of the platform's Code label.
- **Error class:** Derived defaults dropped on one entry path, and technical identifiers shown as names.
- **Guard:** `draft-suggestions.integration.test.ts` creates a body-only reply through `draft.create` and requires the source sender and "Re:" subject, also in the review. The same file requires the platform Code label (`codeAccountPresenter`) for the draft header, the last editor and the conversation row, and never the account key or another owner's title.
