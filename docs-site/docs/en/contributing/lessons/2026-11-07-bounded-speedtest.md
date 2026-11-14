### Measure network rates within a shared time budget

- **What happened:** Fixed-size speedtests took minutes on slow connections, while browser, CLI and generated scripts measured differently.
- **Root cause:** Each consumer implemented its own transfer loops and counted completed requests rather than bytes flowing within a bounded phase.
- **Error class:** Unbounded measurement work and duplicated measurement semantics.
- **Guard:** The shared speedtest engine tests use a fixed clock to enforce 14/29-second caps, five concurrent requests, monotonic remaining time, positive slow-upload rates and sibling cancellation. A throttled real upload checks streaming progress against the host's socket queue budget.
