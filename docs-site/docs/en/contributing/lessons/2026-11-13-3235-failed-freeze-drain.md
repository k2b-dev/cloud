### Release a failed drain only with evidence and its own freeze token

- **What happened:** An application snapshot save rejected after the freeze marker was published. The caller received no token, while editors remained frozen for the 60-second lease.
- **Root cause:** Cleanup handled definite marker rejections but not definite application save rejections after drainage began.
- **Error class:** A failed operation leaves its completed admission fence active without returning ownership to the caller.
- **Guard:** The snapshot pipeline identifies definite save failures separately from cancellation and transport uncertainty. Freeze compensates through the existing token-checked thaw path, including its open marker. Lifecycle unit tests guard immediate retry, uncertain outcomes and newer ownership; the real-NATS integration test proves a throwing app save immediately permits remote edits and a successful second freeze.
