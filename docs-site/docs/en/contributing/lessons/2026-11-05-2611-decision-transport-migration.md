### Decision calls kept a removed transport wrapper after merging main

- **What happened:** The decision feature failed bundling and the documentation harness after merging the Nessi 1.1 migration.
- **Root cause:** Decision calls still imported the deleted global fetch wrapper. Nessi 1.1.1 exposes transport reports for chat requests, but its decision adapter has no transport hook, so forwarding a hook to that adapter would also lose status and accounting metadata.
- **Error class:** An additive feature retained a removed dependency API after an upstream migration.
- **Guard:** The app bundle and documentation harness catch missing imports. Decision HTTP tests verify per-request reports, timing, sanitized failures, and zero usage for refused requests versus estimates for possibly processed requests.
