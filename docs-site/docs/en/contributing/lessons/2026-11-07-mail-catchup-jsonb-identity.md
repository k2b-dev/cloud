### Hash event identity fields, not object serialization

- **What happened:** Catch-up followed by delayed live delivery admitted a second run for the same version and message.
- **Root cause:** The receipt hash serialized the subject object. Postgres JSONB reordered its properties, so live delivery computed a different key from the catch-up snapshot.
- **Error class:** Serialization-dependent idempotency identity.
- **Guard:** `packages/core/src/code/event-catchup.test.ts` compares identities with reversed subject-property order. `packages/core/src/code/events.integration.test.ts` checks catch-up followed by delivery through the persisted broker envelope, retaining one run and linking the live receipt.
