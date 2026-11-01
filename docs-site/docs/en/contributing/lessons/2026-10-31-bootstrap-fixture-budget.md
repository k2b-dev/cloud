### Bootstrap fixtures must restore the enrolled-key count

- **What happened:** The bootstrap nonce cleanup integration test deleted 240 records when its expected admission budget was 120.
- **Root cause:** A preceding runner bootstrap test enrolled an extra application key and left it in the shared test database. Cleanup correctly scales its budget with every enrolled key, including revoked keys.
- **Error class:** Test fixture leakage changes a later test's cardinality-dependent budget.
- **Guard:** The runner test removes its own account, key and rejection record in `finally`, checks that refused bootstrap proofs consume no replay records, and the cleanup test explicitly asserts its one-key budget premise. Production budgets and test timeouts are unchanged.
