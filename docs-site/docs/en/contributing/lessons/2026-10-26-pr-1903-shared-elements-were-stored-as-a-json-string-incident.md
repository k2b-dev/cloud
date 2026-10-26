### Shared elements were stored as a JSON string

- **What happened:** On the branch adding shared Cloud elements to Chat, every new message failed with a server error, also system lines such as "created the chat", before it reached `main`.
- **Root cause:** The insert passed `JSON.stringify(refs)` straight to `::jsonb`; the driver encoded the string once more, so the column held a JSON string instead of an array, and the response schema rejected it. The neighbouring `system_params` already used `::text::jsonb`.
- **Error class:** A JSON value encoded twice on its way into `jsonb`.
- **Guard:** Chat `api/shared.integration.test.ts` reads the stored `refs` back as an array; the integration run caught it. Convention: pass serialized JSON to Postgres as `::text::jsonb`.
