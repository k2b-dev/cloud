### App-key tests must respect package and timestamp contracts

- **What happened:** The repository boundary check rejected a Core test import, and live app-query admission returned HTTP 500 while testing an expired key.
- **Root cause:** The Core test imported a private platform module directly. The expiry fixture stored PostgreSQL `-infinity`, which Bun returns without a Date serializer, although enrollment accepts finite timestamps.
- **Error class:** Test fixtures bypass supported runtime contracts.
- **Guard:** The `boundaries` check enforces package imports. Shared app-key fixtures provide test signing, and `app-queries.integration.test.ts` uses a finite database-relative expired timestamp while asserting HTTP 403 and refusal of new signed calls.
