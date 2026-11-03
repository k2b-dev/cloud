### Reconciling an unclear send changed only the command

- **What happened:** An operator's **Reconcile effect** on a send set the command to `ambiguous`, but left its outbox row in `needs_attention`. No worker checks a send command in that state, so the send stayed open for good, while the action reported that a reconciliation was queued.
- **Root cause:** Reconciliation reset the generic command row. A send's provider check runs from its outbox row, which only the `unknown` state routes to the Sent check.
- **Error class:** A state transition on one row of a two-row state machine.
- **Guard:** `sent-projection.integration.test.ts` ("an operator's reconcile of an unclear send checks Sent and settles it without sending again") requires the reconciled send to end as `reconciled_accepted` from its copy in Sent, with one SMTP submission. The partly accepted case now requires one check from the recorded SMTP answer. Both tests fail without the fix.
