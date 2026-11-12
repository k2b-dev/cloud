### Union validation hid a bulk selection limit

- **What happened:** The dependency update failed both a Grids unit shard and the database certification because an oversized bulk selection lost its actionable 10000-record limit message.
- **Root cause:** Zod 4.6.7 aborts oversized container parsing before parsing elements; wrapping the strict selector schemas in a union then exposes only an invalid-union issue to the first-issue formatter.
- **Error class:** Validation composition hiding actionable field errors.
- **Guard:** `workflow-launcher-invocations.test.ts` checks exact-limit acceptance, oversized explicit and query selectors with field and limit diagnostics, and rejection of mixed or missing selectors before launcher loading or invocation.
