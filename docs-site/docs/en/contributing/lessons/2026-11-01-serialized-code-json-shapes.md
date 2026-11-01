### Serialized values retain their JSON shape

- **What happened:** Persisted serialized values had a different JSON type from their input.
- **Root cause:** A string parameter cast directly to `jsonb` is bound as a JSON string by Bun.
- **Error class:** JSON is encoded twice at the SQL boundary.
- **Guard:** Convert serialized parameters with `::text::jsonb`. Focused activation and lifecycle regression fixtures check stored object shapes and the resulting provider calls; the shared `sql-jsonb-text` rule checks this encoding convention.
