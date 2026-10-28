### Keep editor recovery consistent with the snapshot and pending operation

- **What happened:** Conflicts could strand the editor, displayed defaults could disagree with the saved choice, and retries could repeat an already completed creation step.
- **Root cause:** Editors validated write shapes against read snapshots, read a conditional accessor after clearing its owner, and did not retain progress between dependent writes.
- **Error class:** Incomplete state transitions across concurrent edits and partial writes.
- **Guard:** `AiReview.test.ts` checks merge defaults, snapshot validation, identifiers, replacement requirements and canonical links. `AiReview.browser.test.ts` checks actual conflict retries, partial creation, empty discovery, missing details and native dismissal during pending writes.
