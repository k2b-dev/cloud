### A claimed Spaces task still appeared unassigned

- **What happened:** A person could claim a task without becoming an assignee, so assignment filters missed work already in progress ([#1269](https://github.com/k2b-dev/cloud/issues/1269)).
- **Root cause:** Claim writes and assignee replacements treated working state and responsibility as independent data.
- **Error class:** Claim and assignment diverge.
- **Guard:** `claim-assignment.integration.test.ts` checks that user claims assign once, holder removal is guarded before any write, forced release removes the previous holder, and startup backfill repairs old user claims. The existing item row lock serializes claim writes and assignee replacements.
