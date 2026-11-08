### Match uncaught child errors without rejecting structured log fields

- **What happened:** The Spaces due-event restart test failed on a recoverable work-wake diagnostic even though its child completed successfully.
- **Root cause:** The assertion rejected every `error:` substring, including an indented field in the platform log emitted without NATS before application startup.
- **Error class:** Overbroad diagnostic matching in child-process tests.
- **Guard:** The restart integration test requires exit code zero and rejects Bun's line-start `/^error:/m` marker. Recoverable platform diagnostics remain visible.
