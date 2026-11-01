### App-PWA declarations must defer platform client use

- **What happened:** Creating an App-PWA before platform startup threw during module evaluation, including when an unconfigured integration suite should have skipped.
- **Root cause:** The service captured the pre-start SQL placeholder and constructed four table identifiers immediately. Supplying a database did not prevent the identifiers from using the global client.
- **Error class:** A declaration captures a dependency before its lifecycle begins.
- **Guard:** `packages/cloud/src/app-pwa/platform-clients.test.ts` declares default and injected App-PWAs before startup and verifies setup and operations against successive client bindings. `packages/cloud/src/app-pwa/service.integration.test.ts` also checks that an injected database supplies all table identifiers and query fragments. Database handles and SQL fragments resolve only on use; the gateway integration fixture declares its service inside its suite gate.
