### Observe benchmark startup before loading domain modules

- **What happened:** The benchmark startup test sometimes received empty output instead of its observation marker in CI (#2903).
- **Root cause:** A four-second timer killed the child regardless of progress. The identity benchmark loaded the Cloud barrel's domain graph before calling platform initialization, spending most of its startup time before the observation point.
- **Error class:** A fixed child-process kill deadline truncates readiness evidence while unrelated imports delay startup.
- **Guard:** `packages/core/scripts/bench-platform-start.test.ts` awaits child exit and both complete output streams before checking the marker and transport snapshot. The identity benchmark loads the Cloud barrel only after initialization. Convention `child-exit-before-output`: drain stdout and stderr alongside child exit; use the test deadline and cleanup to bound failure, rather than a shorter timer that kills a progressing child. Keep transport and ordering assertions against the real benchmark entry points.
