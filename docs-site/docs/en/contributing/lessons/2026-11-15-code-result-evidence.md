### Preserve outcome facts for every read surface

- **What happened:** Code history showed Action titles and confirmation counts instead of result sentences; headers lacked activation and pause dates, and version changes did not name their approval cause.
- **Root cause:** The shared read model aggregated calls without an operation result form or lifecycle attribution, and its change rows omitted effective policy classifications.
- **Error class:** A shared presentation contract discards facts required by its consumers.
- **Guard:** Core read-model tests pin localized result forms, authorized target names, fallback counts and approval causes. Data integration tests pin atomic effect evidence, lifecycle dates, person visibility and unchanged SQL counts; the bridge integration test pins capture from a third-party provider catalog.
