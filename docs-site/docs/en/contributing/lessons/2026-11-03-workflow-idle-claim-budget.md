### Idle claim counts include concurrency, modes and both wake phases

- **What happened:** A near-idle production measurement after release 0.63 recorded 531 workflow claim queries per minute despite event-driven worker wake-ups.
- **Root cause:** Every five-second recovery wakes every free slot before and after recovery. Grids defaults to 10 slots and probes execution and dry-run queues; Mail has 2 execution slots. One process of each therefore budgets 12 × 2 × (10 × 2 + 2) = 528 idle claims/minute, consistent with the measurement. Distributed NATS wake-ups already provide immediate work delivery, so the fallback can scan every 30 seconds: 88 claims/minute for that topology.
- **Error class:** Counting periodic work without its concurrency and repeated phases.
- **Guard:** `services/idle-workers.test.ts` drives a frozen minute through the real worker: exactly 2 recoveries and 8 slot probes at concurrency 2, immediate local wake, lost-hint recovery and zero claims after stop. `worker-runtime.integration.test.ts` covers independent NATS publishers, self-echo suppression, the 30-second repair callback and shutdown/restart.
