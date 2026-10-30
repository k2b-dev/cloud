### Keep deployment prerequisites aligned with runtime consumers

- **What happened:** The gateway prerequisites omitted infrastructure values required for public object delivery.
- **Root cause:** The deployment requirements still described the gateway before it gained the storage delivery path.
- **Error class:** Deployment documentation drifting from runtime dependencies and trust boundaries.
- **Guard:** None, because the existing deployment test checks the runtime environment but cannot establish whether prose describes the trust boundary accurately. This correction was verified against Compose and the gateway storage and request-budget consumers.
