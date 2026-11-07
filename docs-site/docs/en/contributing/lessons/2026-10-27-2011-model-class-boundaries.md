### Model class ports must preserve runtime and storage boundaries

- **What happened:** Client bundles pulled in Bun and native server modules; stored model choices and catalog fields returned as JSON strings.
- **Root cause:** Clients imported helpers through the server AI barrel, and new SQL writes bound serialized strings directly as JSON parameters.
- **Error class:** Runtime boundary leaks and double JSON encoding during contract changes.
- **Guard:** The Assistant production bundle and CLI help tests catch server imports. Catalog, preference, machine-token and project integration tests check JSON round trips. The settings guard stays unchanged; the destructive upgrade fixture uses a disposable database.
