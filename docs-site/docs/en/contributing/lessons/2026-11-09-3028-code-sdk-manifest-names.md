### Generated SDK names need an explicit validation boundary

- **What happened:** SDK generation silently omitted entries with invalid names instead of reporting a validation error.
- **Root cause:** The SDK reused the catalog compatibility reader, which intentionally omits unreadable entries.
- **Error class:** A permissive reader used at a strict generation boundary.
- **Guard:** `packages/cloud/src/code/generator.test.ts` rejects invalid app IDs, local paths, targets and ref types, while preserving literal ref-field names through generated types and canonical calls; the existing SDK snapshots preserve valid output. Parsed-markup assertions and AST-built checker exports keep test and generated source boundaries explicit.
