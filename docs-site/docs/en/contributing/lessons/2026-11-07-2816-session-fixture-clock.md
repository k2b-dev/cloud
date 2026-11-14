### Frozen session fixtures must share the database clock

- **What happened:** The Mail installation export test received 401 for a signed-in non-administrator instead of the expected 403.
- **Root cause:** The test froze JavaScript time at midnight before issuing an eight-hour session. Postgres checked session expiry against its real clock, so an afternoon CI run rejected the session as expired.
- **Error class:** Clock mismatch between a test credential and its live validity checks.
- **Guard:** The Mail automation export integration suite freezes time at the database clock, proves that its session authenticates, and separately asserts anonymous 401 and signed-in non-administrator 403 responses.
