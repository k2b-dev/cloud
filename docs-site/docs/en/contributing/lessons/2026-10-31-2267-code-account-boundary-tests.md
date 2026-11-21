### Shared identity predicates must preserve subject-specific dependencies

- **What happened:** Adding Code account rules broke user quota and file permission checks in minimal database fixtures. Two new storage rejection tests hung instead of executing their queries, and an existing bootstrap test could no longer insert its invalid fixture.
- **Root cause:** The shared predicate emitted machine-account queries for known user subjects. Bun SQL queries passed directly to rejection matchers stayed lazy. The bootstrap fixture assumed storage permitted invalid app-key ownership.
- **Error class:** Unconditional query dependencies and fixtures that do not exercise the current storage contract.
- **Guard:** Quota tests check nested user grants without the machine-membership table and require successful machine admission before asserting quota exhaustion. Storage refusal assertions explicitly execute SQL. Bootstrap tests verify storage refusal and separately model legacy rows to retain proof-validation coverage. The Chat picker behavior test excludes Code and still selects an ordinary machine account.
