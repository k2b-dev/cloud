export const OUTBOX_MAX_ATTEMPTS = 5;
/** Command metadata: the outbox attempt after which an operator's reconciliation gets its own provider check. */
export const OPERATOR_RECONCILE_FROM_ATTEMPT = "operatorReconcileFromAttempt";
export const OUTBOX_DISPATCH_GRACE_SECONDS = 10;
/** A send waits for its mailbox to be signed in again, or went back to the drafts because that took too long. */
export const OUTBOX_MAILBOX_AUTH_REQUIRED = "MAILBOX_AUTH_REQUIRED";
