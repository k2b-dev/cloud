### Automatic workload issuance needs durable revocation and bounded recovery

- **What happened:** Restarting an app bypassed an administrator's credential revocation; transient credential refresh failures interrupted background work, and cached rejected tokens could turn a recoverable outage into a permanent workflow failure.
- **Root cause:** Revocation was scoped to a process instance, workers started before credential acquisition, and the consumer treated cached credential state as permanent authorization failure.
- **Error class:** Automatic renewal bypasses lifecycle intent and misclassifies transient authority state.
- **Guard:** `app-workload.integration.test.ts` checks app-wide disablement across instances, explicit recovery, and the refresh grace period. `workload-client.test.ts` checks one pre-dispatch credential refresh and retry with HTTP 503 on persistent failure. `workload-credential.test.ts` checks valid-token preservation and one recovery notification. `define-app.startup.test.ts` checks credential acquisition before workers and route advertisement after startup.
