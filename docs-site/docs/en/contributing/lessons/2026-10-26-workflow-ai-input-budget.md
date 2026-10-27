### Inference inputs must fit the durable storage budget before insertion

- **What happened:** Long Mail input passed task validation and failed as a generic Postgres error after loading the entire body.
- **Root cause:** Only the JSONB check constraint enforced the 100,000-byte task budget. Character counts and compact JSON do not measure UTF-8 or JSONB expansion.
- **Error class:** Input validation omits the serialized storage representation.
- **Guard:** `ai/task-size.test.ts` covers envelope overhead, UTF-8, escaping and byte boundaries. `workflows/ai-actions.test.ts` verifies a permanent machine-readable error before insertion. The store integration test covers numeric expansion in JSONB; Mail resolver tests cover the body limit without silent truncation.
