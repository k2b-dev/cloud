### Delayed identity hints exhausted replica startup revalidation

- **What happened:** A valid live socket reconnecting to another replica closed with `1013 access_changing` before it could replay updates.
- **Root cause:** The startup notification used one credential catch-up. A real identity hint committed before the handshake but published during that catch-up exhausted the engine's two-pass limit even though access remained valid.
- **Error class:** Treating delayed invalidation hints as proof that a bounded number of reads cannot settle.
- **Guard:** The two-replica live-routes regression holds the fixture's real identity outbox publication until startup catch-up, then requires replay without closure. The engine deadline test bounds unsettled catch-up without timing the first check or its slot wait; ordered delivery still waits for in-flight access checks. Third-pass credential and channel revocation tests block pending content, existing two-replica revocation tests preserve prompt access removal, and the live SQL budget pins catch-up queries and zero-query content delivery (DATA-13).
