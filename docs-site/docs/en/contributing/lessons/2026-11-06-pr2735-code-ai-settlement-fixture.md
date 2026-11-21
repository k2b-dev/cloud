### An AI settlement test stopped at the identity guard

- **What happened:** Both failed-generation settlement cases returned `code_mandate_mismatch` before invoking AI, so they never exercised usage settlement or error projection.
- **Root cause:** The fixture created personally owned Code but left its mandate bound to a service account. The adjacent successful personal-call test explicitly binds its mandate to the owner; the new cases omitted that setup.
- **Error class:** A test fixture fails an earlier prerequisite and never reaches the behavior under test.
- **Guard:** The settlement cases now bind the mandate to the personal owner and assert exactly one AI invocation, while retaining the expected projected error and exact known/unknown usage totals. The independent mismatched-mandate rejection test remains unchanged.
