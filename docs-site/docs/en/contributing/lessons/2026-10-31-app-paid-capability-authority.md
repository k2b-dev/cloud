### App-paid operations need an application authority

- **What happened:** Public app forms could not call platform capabilities without a person or a mandate.
- **Root cause:** The server capability client and dispatcher had no declared, signed app-paid authority beyond resource reader checks.
- **Error class:** A public application contract models only interactive callers and omits the application as an actor.
- **Guard:** `app-capabilities.test.ts` covers declared permission, third-party parity, signed transport, app/key audit, overload and key revocation; the Core broker and Geo integration tests cover durable admission and per-app accounting.
