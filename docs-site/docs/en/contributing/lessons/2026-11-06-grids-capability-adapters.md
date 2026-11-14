### Preserve error classification when sharing domain helpers

- **What happened:** Extracting Grids record locking into a shared domain helper changed a missing workflow lock from a terminal action failure into an unclassified exception.
- **Root cause:** The extracted helper returned an error object while the workflow adapter catches its own error class.
- **Error class:** A shared implementation loses the caller's observable error contract.
- **Guard:** `workflow-atomic-records.test.ts` checks the workflow adapter's error class, stable code and nonretryable classification for a missing record. The existing missing-lock workflow integration case checks the full action boundary.
