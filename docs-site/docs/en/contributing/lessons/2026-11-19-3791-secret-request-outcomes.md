### Secret lookup and completion must preserve authoritative evidence

- **What happened:** A secret beyond the first metadata page could appear new, replacement could loop on conflicts, and lease expiry during a write reported a definite failure despite an uncertain outcome. Invalid input and other rejected writes also shared one presentation state.
- **Root cause:** The browser compared database cursors using JavaScript string order, collapsed distinct failure causes, and discarded whether a write had started when the lease expired. Completion also trusted the browser's result name instead of the authorized request name.
- **Error class:** Cursor collation mismatch, lost outcome evidence, and untrusted completion metadata.
- **Guard:** Secret request transport tests cover mixed-case pages, repeated cursors, exhausted page budgets and complete absence scans. Controller and runtime behavior tests distinguish rejection reasons and preserve an uncertain outcome after lease expiry and completion failure without exposing the value. API tests pin completion to the requested name; the model schema test preserves its name pattern.
