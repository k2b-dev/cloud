### A cancelled alert check counted a released claim as an attempt

- **What happened:** The Pulse interruption test saw `attempted: 2` for one alert rule on an unrelated pull request.
- **Root cause:** While one worker cancelled its check and restored the rule's due time, a second worker claimed the same rule, counted it, and released it unchecked because the signal had aborted.
- **Error class:** A parallel worker counts work before it checks for cancellation.
- **Guard:** `evaluateDueAlerts` counts a claim only after the cancellation check; the interruption test in `packages/pulse/src/service/alert-rules.integration.test.ts` asserts exactly one attempt with all workers.
