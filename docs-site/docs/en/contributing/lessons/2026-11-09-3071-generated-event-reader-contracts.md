### Generated event readers must satisfy application contracts and fixture lifecycle rules

- **What happened:** Foreign-event support failed the gate on missing German query presentation, an outdated Chat query inventory, and event integration fixtures.
- **Root cause:** Newly generated app-only queries lacked application-owned translations and input descriptions. Fixtures changed immutable Code identities after insertion and stamped cross-event occurrences before the last subscription cutoff.
- **Error class:** A generated contract changed without checking every consumer, and test fixtures bypassed real identity and activation lifecycle rules.
- **Guard:** `capability-presentation`, `tests/capability-presentation.test.ts`, and the exact app-only query inventory in `packages/chat/src/commands.test.ts` cover the generated presentation contract. `packages/core/src/code/events.integration.test.ts` creates identities before versions and mandates, uses the final subscription cutoff, and requires both deliveries before checking their order.
