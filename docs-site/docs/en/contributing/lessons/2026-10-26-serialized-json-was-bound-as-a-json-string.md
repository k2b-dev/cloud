### Serialized JSON was bound as a JSON string

- **What happened:** An App-PWA visit could be claimed, but its next domain operation rejected the stored subject.
- **Root cause:** Binding `JSON.stringify(value)` directly to a `jsonb` parameter made Bun encode a JSON string. A bare JavaScript UUID array also failed PostgreSQL array binding.
- **Error class:** Driver parameter encoding differs from the stored domain shape.
- **Guard:** `service.integration.test.ts` round-trips visit subjects, command results and device lists through real PostgreSQL. Serialized JSON uses `::text::jsonb`; UUID lists use `sql.array(ids, "uuid")`.
