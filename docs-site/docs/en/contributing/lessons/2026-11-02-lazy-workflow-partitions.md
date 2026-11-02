### Idle applications start background consumers without work

- **What happened:** Every Grids process started 32 workflow record-event pull loops even without an enabled record-event workflow. Every application process also ran a scheduler worker for the same hourly links cleanup.
- **Root cause:** Record-event reconciliation started the partition worker unconditionally, and shared links provisioning also registered retention in every application.
- **Error class:** Background consumers follow process lifetime instead of domain demand or the owning service.
- **Guard:** `workflow-record-events.test.ts` counts zero queue starts across three concurrent idle reconciliations. `record-events.integration.test.ts` checks zero idle workers, exactly 32 durable consumers with one worker after activation, zero workers after disabling, ordered delivery across restart, and one worker start under concurrent reconciliation. `links/runtime.integration.test.ts` counts zero retention schedulers in a non-Core application and one per Core replica; `define-app.startup.test.ts` verifies the declared app ID reaches links startup.
