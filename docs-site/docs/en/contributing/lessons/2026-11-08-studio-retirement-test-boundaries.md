### Keep retirement tests on surviving public boundaries

- **What happened:** Studio retirement left integration fixtures expecting removed result links and an obsolete approval exemption.
- **Root cause:** The fixtures changed their imports and requester types without following the surviving public routes and approval lifecycle.
- **Error class:** Test contract drift after feature retirement.
- **Guard:** The Assistant OAuth integration enumerates the mounted public API. Chat-result tests retain file delivery and legacy transcript reads; the turn-ending test covers unused and consumed generic and chat-code approvals.
