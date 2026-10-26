### Concurrent upload commits rejected each other

- **What happened:** Two tabs uploading small files into the same storage root lost commits to retryable busy errors ([#1165](https://github.com/k2b-dev/cloud/issues/1165)).
- **Root cause:** Private commits shared a broker root lease configured for a single acquisition attempt, so even brief contention rejected publication immediately.
- **Error class:** Ordering and concurrency.
- **Guard:** `filegate-lifecycle.integration.test.ts` pairs forty real uploads at their commit boundary. `files.integration.test.ts` checks publication after a short lock, busy after the five-second wait, one shared wait budget for a multi-entry move, immediate root-lock attempts without a wait or after its budget expires, and immediate capability-upload rejection without consuming its body. Publications and trash mutations opt into a wait per request; listings and administrative lifecycle operations retain a single attempt.
