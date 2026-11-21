### Code AI bridge fixtures omitted the inference ledger

- **What happened:** C4 integration tests returned `code_bridge_unavailable` for decision, generation, and non-model AI queries.
- **Root cause:** Shared daily admission began reading actual Code-started chat costs from `ai.inference_calls`, but the bridge fixture had not run the inference ledger migration. PostgreSQL raised `42P01` before dispatch.
- **Error class:** A shared service gained a database dependency without updating its integration fixture.
- **Guard:** The C4 signed runner bridge suite runs the canonical quota migration. Its existing decision, generation, reservation settlement, and daily-budget assertions remain unchanged.
