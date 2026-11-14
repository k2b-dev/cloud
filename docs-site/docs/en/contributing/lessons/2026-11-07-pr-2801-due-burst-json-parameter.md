### Cast serialized JSON through text before passing it to Postgres

- **What happened:** The Spaces due-event burst integration test failed while inserting its task fixtures, before it exercised the sweep.
- **Root cause:** Binding `JSON.stringify(burst)` directly to `::jsonb` made Bun encode the string as a JSON scalar. `jsonb_to_recordset` requires an array; `::text::jsonb` parses the serialized array correctly.
- **Error class:** Driver-dependent JSON parameter encoding in SQL fixtures.
- **Guard:** The due-event burst integration test inserts the full batch through `::text::jsonb`, asserts its row count, and then checks watermark, throughput, restart and idempotence behavior.
