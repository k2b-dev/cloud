### Native client bindings must stay live through startup and replacement

- **What happened:** Logging before platform startup threw while reporting another error. Services imported before startup or a test database switch kept an unusable SQL handle.
- **Root cause:** The pre-start placeholder throws synchronously, before a query's rejection handler attaches. Service factories copied the exported client into module-owned closures, and the test target guard checked only Bun's global client.
- **Error class:** Capturing lifecycle-owned dependencies too early and assuming asynchronous failure at a logging boundary.
- **Guard:** Logging catches synchronous and asynchronous persistence failures while retaining console output. Default service clients, including the POSIX singleton and the Geo ledger created by routing and maps at import time, resolve when used; injected pools remain owned by the caller. Startup logging, service replacement, and mismatched-platform-target tests cover these paths. The migration guard matches baseline source contents, and codemod tests cover comments, reused bindings, nested pool arguments, and repeated runs.
