### Preserve published capability enums when adding status operations

- **What happened:** Mail capability provider conformance failed after adding work statuses and required-idempotency Actions.
- **Root cause:** Existing status input and result enums were expanded under published local IDs, and new Actions were missing from the explicit idempotency inventory.
- **Error class:** Published contract evolution without provider conformance verification.
- **Guard:** `tests/capability-providers.test.ts` checks frozen manifests and the required-idempotency inventory. Mail capability contract tests also reject new statuses on the old update IDs and accept them on the new set IDs.
