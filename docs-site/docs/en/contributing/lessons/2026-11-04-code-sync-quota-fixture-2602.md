### Quota isolation fixtures need explicit machine allowances

- **What happened:** The service-account quota isolation test failed after merging the people-only `authenticated` tier with a stricter initial-allowance assertion.
- **Root cause:** The fixture assigned only an `authenticated` allowance. Machines therefore had a zero limit before any usage; the older test accepted their later rejection without checking that they could start.
- **Error class:** A negative assertion passes for the wrong reason when fixture grants lag shared principal semantics.
- **Guard:** `packages/cloud/src/ai/quotas.integration.test.ts` checks people-only allowances before usage, then gives agent and Code accounts explicit allowances and verifies independent user, agent and Code balances before and after charging.
