### Call Core from independently deployed apps through its transport

- **What happened:** The Assistant's shared waiting list and badge could fail while the same read passed inside Core.
- **Root cause:** Assistant passed its verified request authority into the capability client's Core-only in-process dispatcher, which cannot execute Core-owned operations inside another application process.
- **Error class:** Deployment-boundary mismatch hidden by a mocked consumer and local database tests.
- **Guard:** Assistant now forwards the person's credentials to Core through the public server client. The list transport regression runs without a started database, returns both approval and Code entries, and checks the badge uses the same read. The PWA route test verifies credentials are forwarded and local authority is absent.
