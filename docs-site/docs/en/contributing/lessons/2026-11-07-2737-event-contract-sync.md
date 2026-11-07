### Event fixtures and translations must follow the current contract

- **What happened:** The Code event integration fixture failed while loading, and Core's German capability presentation test reported missing event registration fields.
- **Root cause:** A branch sync introduced the requirement that an event's place Type have a reader and a test that checks every input-schema field's translation. The Code fixture lacked the reader and a bound for its event ID string, and the event registration fields lacked translations.
- **Error class:** A feature branch retains incomplete fixtures or presentation after adopting stricter shared contracts.
- **Guard:** The Code event integration fixture declares a canonical collection reader and uses the public resource ID schema for its event data. Loading `packages/core/src/code/events.integration.test.ts` checks that declaration even without test infrastructure; `tests/capability-presentation.test.ts` checks every German input-schema field.
