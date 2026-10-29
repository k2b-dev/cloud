### Large uploads timed out after all bytes arrived

- **What happened:** Files could not finish uploads above about 1.3 GiB; every retry reached the same commit timeout ([#1164](https://github.com/k2b-dev/cloud/issues/1164)).
- **Root cause:** The Filegate wrapper gave commits the ordinary 10 s API deadline. App requests and clients also had shorter budgets than a large commit needs.
- **Error class:** Deadline shorter than bounded work.
- **Guard:** `filegate-timeout.test.ts` checks the production classifier and SDK URL; `upload-commit-route.test.ts` checks both routes restore socket timeouts. `api-error.test.ts` keeps a storage deadline retryable (`unavailable`, 503) instead of `internal`. The delayed real commit in `filegate-transfer.integration.test.ts` detects a short wrapper deadline. Browser and CLI retry tests retain the same upload identity after ambiguous commit answers.
