### An interruption is not a person's refusal or permission to ignore a deadline

- **What happened:** Send now recorded a skipped approval as denied by the person. A worker could also stop after an uncertain client result withdrew the interrupt, or continue past its run deadline.
- **Root cause:** The executor supplied `approved: false` for an undecided approval. The worker latched an interrupt on delivery without receipt confirmation or withdrawal, and the heartbeat returned on the queue reason before checking the deadline or lost lease.
- **Error class:** Conflating a revocable control request with a durable decision.
- **Guard:** The Send now contract regressions in `executor.test.ts` cover skipped ordinary and nested approvals, withdrawal after delivery, and deadline precedence. `turn-interruption.test.ts` holds idle workers until confirmation. `executor.integration.test.ts` verifies a live worker continues after withdrawal; `queue-send-now.integration.test.ts` verifies receipt authority and persistence of time-limit failures.
