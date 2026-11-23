### Removing runtime tokens would have left Core without an identity for its own reader queries

- **What happened:** The rebuilt app-key cut removed the runtime tokens that every app process, Core included, received automatically. Since Code moved into Core, Core asks other apps' `readable` and `managers` queries as the app `core`; without a token and without an app key, these checks would have answered "not configured".
- **Root cause:** The cut was planned before Code moved into Core. Its caller list named apps only, and Core cannot hold an app key.
- **Error class:** A credential removal that misses a caller added after the plan.
- **Guard:** `packages/cloud/src/capabilities/server.test.ts` checks that Core's own app queries run in process without a key and that no other process can send them; `resource-readers.test.ts` checks Core's reader and manager calls without `CLOUD_APP_KEY`.
