### Persist Code refusal facts before run completion

- **What happened:** Run metadata had no durable reference to a target refusal. A page had to inspect call results, and a dispatch 403 could also describe policy or app admission.
- **Root cause:** The call observation and run metadata had no shared refusal classification at the bridge boundary.
- **Error class:** An observation loses its source before a later consumer classifies it.
- **Guard:** Bridge unit and integration tests distinguish provider 403/404 from policy, approval, app admission and bridge failures. Core's gated data integration test rolls back call settlement and its run ordinal together, checks out-of-order completion, and reads a refused call beyond the current page with a chunked input. Reader and Cloud-admin projections contain no target ID. A browser bundle test keeps the shared data schemas free of server API imports.
