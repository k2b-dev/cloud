### Discussion post retries must match their original input

- **What happened:** Reusing a discussion post key with a changed body or reply target returned an earlier message after Core's claim expired.
- **Root cause:** Message deduplication checked the client key without comparing the original post input.
- **Error class:** Idempotency key reuse without durable input validation.
- **Guard:** Discussion capability integration tests reject changed bodies and reply targets, force concurrent requests through the locked replay path, and preserve identical replays after edits. Deletion removes the input fingerprint and makes provider-side post retries fail closed.
