### An additive catalog column breaks older services

- **What happened:** The unreleased 0.71 migration added `ai.models.output_token_limit`, causing services on `@k2b/cloud` 0.63 to reject every model row and fail all AI requests.
- **Root cause:** Catalog readers selected whole rows with `to_jsonb(t)` and parsed them with schemas that rejected unknown keys. Adding a nullable column changed every row's shape, including rows with no configured limit.
- **Error class:** An additive column breaks older strict readers.
- **Guard:** `model-catalog.test.ts` verifies that stored catalog schemas strip unknown keys while admin inputs remain strict. `model-classes-migration.integration.test.ts` parses physical provider, model, variant and assignment rows with frozen 0.70 schemas, verifies lossless migration into `ai.model_output_limits`, and checks rerun safety. Keep new metadata outside tables consumed by already released strict readers.
