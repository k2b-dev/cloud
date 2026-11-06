### New response handlers bypass the shared API contract

- **What happened:** New document endpoints serialize their successful payloads directly instead of using the application API response mechanism.
- **Root cause:** New document routes returned JSON directly instead of using the shared API result responder.
- **Error class:** New response handlers bypass the shared API contract
- **Guard:** Check: `service-api-contracts` rejects direct JSON responses in application APIs. Shared draft endpoints now use `respond` and `ok` while keeping their payloads unchanged.
