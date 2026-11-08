### An unavailable upload receipt is not a failed publication

- **What happened:** Two Files browser tests expected a new upload key after an unavailable or mismatched receipt. That policy could publish a second copy after the first publication succeeded but its response was lost.
- **Root cause:** The browser treated an HTTP 409 as proof of a final failure, although Files keeps the server reservation unresolved. The public inbox reports this state as `upload_uncertain`; private receipt recovery uses `receipt_unknown`.
- **Error class:** Replacing an idempotency identity before an ambiguous side effect is reconciled.
- **Guard:** The public inbox behavior test models publication before receipt loss, verifies that repeated retries keep one publication, then recovers the original receipt. The workspace behavior test keeps the same key through repeated unknown answers. The existing final-rejection test still requires key cleanup after an explicit authorization rejection.
