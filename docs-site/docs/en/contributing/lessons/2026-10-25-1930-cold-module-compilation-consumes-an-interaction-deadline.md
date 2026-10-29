### Cold module compilation consumes an interaction deadline

- **What happened:** The first behavior case spends its timeout compiling a large island, then its unfinished async work overlaps the next case’s mocks and DOM.
- **Root cause:** Cold module compilation consumes an interaction deadline.
- **Error class:** Cold module compilation consumes an interaction deadline.
- **Guard:** Convention: load the source graph before registering interaction cases, using the suite’s DOM harness for browser modules. Files `history-contact.behavior.test.tsx` follows the existing workspace suites and keeps every interaction at the default deadline.
