### Grouped dependency updates changed runtime and test contracts

- **What happened:** A grouped update failed typechecks, documentation builds, packed consumers, accessibility checks, Grids certification, and protocol and bundle regression tests.
- **Root cause:** The group included a Babel major migration, incompatible SQL types, changed OpenAPI and IMAP behavior, an unapplied spreadsheet patch, unstable bundle measurement, and browser and font changes that invalidated fixture assumptions.
- **Error class:** Dependency updates crossing independently owned contracts.
- **Guard:** Keep exact deferred pins in the dependency policy; run SSR transform and build tests, Chat OpenAPI and Grids route tests, Mail protocol tests, spreadsheet round trips, island bundle measurement tests, and browser accessibility and font tests before adopting those updates.
