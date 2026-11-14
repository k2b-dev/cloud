### Additive run metadata must preserve existing clients and fixture dependencies

- **What happened:** Existing Code CLI run responses were rejected, the Core capability inventory omitted event replay, and event delivery integration cases failed before reaching admission.
- **Root cause:** The run-list schema required the new event delivery field. The exact capability inventory lacked the new action. The integration fixture omitted rail cache and activation migrations, and its simulated mandate revocation omitted required metadata.
- **Error class:** An additive feature changes an existing response requirement or leaves contract inventories and integration dependencies incomplete.
- **Guard:** The unchanged C18b cases still verify legacy responses; an added case verifies event delivery metadata survives JSON and JSONL output in both locales. The exact Core capability inventory includes event replay. The event fixture applies the owning migrations and creates a constraint-valid revocation; its existing admission assertions remain unchanged.
