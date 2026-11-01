### Serialized JSON parameters need an explicit text conversion

- **What happened:** Code scheduling and bridge fixtures stored JSON strings where queries expected objects ([#2336](https://github.com/k2b-dev/cloud/issues/2336)).
- **Root cause:** Bun binds a JavaScript string as a JSON string when its SQL parameter is cast directly to `jsonb`.
- **Error class:** JSON serialization applied twice at the database boundary.
- **Guard:** Use `${JSON.stringify(value)}::text::jsonb` for serialized text, or pass an object directly. The `sql-jsonb-text` repository rule checks tagged SQL templates, local text aliases and typed text parameters. Its deliberately wrong fixture proves detection, and the bridge integration fixture checks stored JSON object types. Existing callers outside Code have a bounded baseline for separate migration.
