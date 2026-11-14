### Temporary room failures must not terminate an unsent command

- **What happened:** A scheduled collaborative draft could return as a failed send when another freeze or a broker timeout interrupted dispatch, before SMTP started.
- **Root cause:** The outbox classified provider and database failures as retryable but did not classify failures from the new room boundary. The room verification seam now reports temporary failures to the existing bounded outbox retry; content mismatches remain final failures. Lifecycle and transport failures use bounded retries before SMTP.
- **Error class:** Adding a dependency without carrying its temporary failures into the caller's retry policy.
- **Guard:** `packages/mail/src/service/sent-projection.integration.test.ts`, “shared-room dispatch retries a transient %s before SMTP, then sends once”, injects lifecycle, conflict and broker-timeout failures only at dispatch. The real SQL/outbox and SMTP paths must queue a retry without submission, then send exactly once.
