### Fixture errors can hide the boundary an integration test exercises

- **What happened:** Policy-free Code entries exposed a JSON constraint failure in the single-connection identity suite and an idempotency conflict in the foreign-target acceptance case.
- **Root cause:** The SQL fixture encoded a policy as a JSON string. The foreign-target fixture changed a successful call's target while retaining its idempotency key, so the digest conflict intercepted the provider's access check.
- **Error class:** Invalid or overlapping fixture inputs intercept the behavior under test.
- **Guard:** `identity-issuance-pool.integration.test.ts` inserts a policy object through a text-to-JSONB cast. C25 acceptance gives the foreign-target call its own stable key and still requires `not_found`, no foreign writes, and one write for repeated authorized calls.
