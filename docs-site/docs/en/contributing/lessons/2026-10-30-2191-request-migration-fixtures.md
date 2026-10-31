### Request transport migrations include access and failure fixtures

- **What happened:** CI rejected the internal OAuth JWKS route inventory, and device approval failure tests received successful responses instead of HTTP 503.
- **Root cause:** The access fixture omitted the new route. Fetch spies expected URL strings and an init body, so they missed the shared transport's `Request` objects and called the real test authority.
- **Error class:** Stale test fixtures after a transport migration.
- **Guard:** `builtins-access.test.ts` includes the JWKS route and protected neighbors; `device-grant.integration.test.ts` intercepts `Request` objects and verifies HTTP 503, request counts, and preservation of unrelated pending grants.
