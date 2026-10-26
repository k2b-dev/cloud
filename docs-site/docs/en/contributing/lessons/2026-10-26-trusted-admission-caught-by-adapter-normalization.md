### Trusted admission caught by adapter normalization

- **What happened:** Wrapping a dispatch guard with provider-error normalization erases its type, changes 401/403 responses to 502, and charges estimated usage before dispatch.
- **Root cause:** Provider-error normalization wrapped the trusted dispatch guard together with the adapter.
- **Error class:** Trusted admission caught by adapter normalization
- **Guard:** Tests: Cloud `quota-provider.test.ts` preserves dispatch-error identity and zero usage for both provider methods; `openai-api.test.ts` revokes credentials or model access after quota admission and requires the original status, no dispatch, and zero usage for JSON and SSE. Normalize only the adapter, before trusted guards and accounting.
