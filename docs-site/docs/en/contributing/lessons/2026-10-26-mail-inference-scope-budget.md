### Fresh workflow runs must share source inference and admission budgets

- **What happened:** Retrying Mail after a later action failed repeated successful inference. Every incoming message also received a fresh per-run budget, allowing an unbounded mailbox burst.
- **Root cause:** Run/step idempotency was treated as a source cache and an aggregate operating budget.
- **Error class:** Per-operation accounting omits the durable source and admission scope.
- **Guard:** Workflow AI store integration tests cover cross-run reuse, explicit recomputation, configuration/revision/mailbox invalidation, concurrent admission, global capacity, token-bucket refill and rolling daily limits surviving run deletion. Policy tests cover canonical input and model configuration identities, including cosmetic profile edits. Action tests distinguish retryable capacity/rate rejection from terminal source/day limits. Mail contract and CLI tests enforce deliberate recomputation only on explicit retries.
