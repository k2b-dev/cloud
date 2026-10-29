### Preserve resumable map export bytes and receipts

- **What happened:** A refreshed viewing clock could change an export digest; missing persistence or simultaneous tabs could create duplicate notes.
- **Root cause:** Export identity depended on viewing time, and browser save progress needed durable receipts and exclusion between tabs.
- **Error class:** A resumable export changes on read, or its browser receipt disappears.
- **Guard:** Cloud `map-notebook.test.ts` freezes export bytes across viewing times; `map-widget.browser.test.ts` exercises bounded create/append, stored checkpoints, cancellation, reconciliation, completed receipts, storage failures and same-source tab exclusion.
