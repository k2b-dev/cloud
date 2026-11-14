### Give public speedtests their own entry context

- **What happened:** The anonymous server page initially showed a Cloud CLI command, rendered an expected rate limit as a measurement error, and used an implicit public origin.
- **Root cause:** The shared measurement view inherited Cloud entry defaults while server configuration supplied an origin default suitable only for Cloud clients.
- **Error class:** Consumer defaults cross a product boundary.
- **Guard:** The production SSR test checks the initial Node command and immutable stylesheet cache. Configuration tests require the operator's origin. Browser guards cover neutral rate-limit feedback, bounded verification and its fixed layout slots.
