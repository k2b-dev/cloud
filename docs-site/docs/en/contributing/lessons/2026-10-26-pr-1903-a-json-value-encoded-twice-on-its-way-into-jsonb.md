### A JSON value encoded twice on its way into `jsonb`

- **What happened:** Serialized JSON reaches a `::jsonb` cast as a string parameter, and the column stores a JSON string instead of the object or array.
- **Root cause:** A JSON value encoded twice on its way into `jsonb`.
- **Error class:** A JSON value encoded twice on its way into `jsonb`
- **Guard:** Test: Chat `api/shared.integration.test.ts` reads stored `refs` back as an array. Convention: serialized JSON goes to Postgres as `::text::jsonb`.
