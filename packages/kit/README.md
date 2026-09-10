# Kit

Kit runs user-authored browser tools in an isolated worker. It also displays Markdown pages without launching a script. Files and local KV/OPFS data stay on the device unless the script explicitly sends data through an enabled shared database or downloads a file.

## Shared databases

Cloud administrators configure rsql under `/admin/kit`. Shared databases are disabled by default. Each app administrator can then enable one shared database for that app. All users with Use permission share its rows; this is not per-user storage. App Admin can change schema, reset and export the database. Global administrators can recover permissions and delete orphaned apps.

Disabling globally or per app preserves all data. Reset replaces the schema and rows with an empty database. Deleting an app queues deletion of its database; unavailable servers are retried for cleanup. Local browser data on other devices cannot be remotely deleted. Pending cleanup prevents changing the server address or removing required credentials.

`kit.db` exposes tables, rows, a restricted SELECT subset and `importData`. The in-app Help and `cld kit sdk` are the API reference. The worker receives neither the rsql token nor general network access.

## Imports and concurrency

`importData` appends data in sequential, bounded batches. It reports only confirmed rows. A cancelled import retains completed batches. If a response is lost, the last batch may already be stored: the result is `unknown`, and Kit does not replay it. Review the data before importing again. Safe batch replay and durable resume are backlog work. A deliberately new import is not deduplicated automatically.

Keep application concurrency proportionate. Most small Kit apps are used by one person: start with straightforward reads, writes and sequential imports. Do not add distributed locks, queues, optimistic updates, conflict-resolution systems or background polling without a real workflow that needs them. Kit already checks permissions and database generations server-side; rsql serializes writes within a database.

For genuinely shared workflows, use unique constraints and clear ownership of edits. A read followed by a write is not an atomic transaction, and multiple import batches are not one transaction. Do not present check-then-write logic as a concurrency guarantee. If the workflow needs an atomic multi-table operation, establish a supported backend contract before relying on it. A stale script must restart after reset. Stopping a worker does not undo writes already accepted by the server.

## Local development

`bun run dev:infra` prepares a private local rsql token and starts `ghcr.io/k2b-dev/rsql:1.0.0` with a persistent Docker volume. Kit connects internally at `http://rsql:8080`; no host port is needed. The feature remains off until enabled in the global Kit settings. `dev:down` retains infrastructure; `dev:infra:down` stops it without deleting volumes. Kit can start and run local-only tools without rsql.

`KIT_RSQL_URL` and `KIT_RSQL_API_TOKEN` provide server-side setting fallbacks. The local bootstrap writes matching values into the ignored `.local/rsql/credentials.env`. Never commit that file or put a real token in CLI arguments. Production rsql is optional; provide a private endpoint, persistent storage and backups before enabling it.
