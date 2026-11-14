### Configure stored renderer settings in direct capability tests

- **What happened:** The Grids document capability certification failed only when it reached PDF issuance, despite a configured test renderer endpoint.
- **Root cause:** `GOTENBERG_URL` bootstraps `gotenberg.url` during application startup. The direct capability fixture skipped startup and left the stored renderer setting empty.
- **Error class:** A test assumes startup has converted its environment into runtime settings.
- **Guard:** The PDF case in `integrity-capabilities.integration.test.ts` sets and restores `gotenberg.url` explicitly and reports the underlying issuance error.
