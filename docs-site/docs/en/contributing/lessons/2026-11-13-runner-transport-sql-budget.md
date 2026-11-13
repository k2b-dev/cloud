### A stubbed transport cannot establish a server SQL budget

- **What happened:** A Runner response-chunk test with Core stubbed reported zero SQL, although it could not observe Core or provider queries.
- **Root cause:** The SQL meter surrounded a client transport with no database consumer.
- **Error class:** A test measures a different boundary from the behavior it claims to guard.
- **Guard:** DATA-13; measure signed capability requests at the Core bridge with the real database. Keep the Runner test as a transport smoke test. Pin chat delivery, preview reads, mailbox polls and lease requests separately.
