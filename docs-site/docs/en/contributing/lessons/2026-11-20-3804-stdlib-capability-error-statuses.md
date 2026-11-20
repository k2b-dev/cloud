### Capability errors drifted from the service error contract

- **What happened:** Applications using stdlib 0.35 or later could return a valid service error such as status 422, but Cloud replaced its code and message with `INVALID_APP_RESPONSE`.
- **Root cause:** The platform maintained a smaller status allowlist without checking it against the dependency's expanded `ServiceError.status` union. Mail also retained a 500 workaround for read outages.
- **Error class:** A dependency expands a typed public contract while a downstream runtime boundary still rejects its new values.
- **Guard:** `capabilities.test.ts` checks at compile time that Cloud and the runtime fixture cover every stdlib status. It exercises returned and thrown failures for every supported status, retains cancellation 499, and rejects unsupported statuses. Mail's existing public GET integration guard requires the stable read-unavailable code with 503; its localized recovery text remains covered by unit tests. The local verification chain also runs `docs-site`’s `check:docs` to catch missing page metadata before pushing.
