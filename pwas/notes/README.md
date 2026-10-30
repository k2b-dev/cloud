# k2b notes server

This standalone Bun/Hono service uses its own Postgres database. It does not
register with Cloud and needs no Core, gateway, NATS, or Valkey.

Run `bun run --cwd pwas/notes start` with `DATABASE_URL` pointing at the Notes
database. Startup applies the versioned SQL migrations in one transaction.
Port 3000 serves `/healthz` for process liveness and `/readyz` for database and
schema readiness. A readiness failure returns 503 without database details.

The server and client live in the same workspace. The server owns `server/`
and `migrations/`; the SPA owns `src/`, `index.html`, and its build script.

## Server acceptance checklist

- [x] Standalone process, versioned schema, health and readiness.
- [x] Standard Yjs sync, durable commit before broadcast and acknowledgement.
- [x] Recovery across crashes and concurrent compaction.
- [x] Independent read/edit links, write checks, connection-owned awareness.
- [x] Text, state, connection, rate, and total storage limits.
- [x] Checked image/PDF files in Postgres.
- [x] Explicit human-open signal and six-month expiry.
- [ ] Reports, password-protected moderation, and decision log.
- [x] Escaped link metadata and a network-free 1200 × 630 preview.
- [ ] SPA/API/WebSocket image and graceful shutdown.

Run the integration files through the repository test runner with
`CLOUD_TEST_DATABASE_URL`. The shared fixture refuses databases whose names
do not end in `_test`; each file creates and drops its own database.

## Sharing API and sync

`POST /api/pads` accepts `{accepted:true, snapshot:"<base64 Yjs state>", title?:"..."}`
and returns `{readId,editId}`. Each link contains an independently generated
128-bit Base62 capability. Only the edit capability can write or delete.
`GET /api/pads/:id` returns `{readId,role,title,snapshot,content,status,liveAvailable}`.
`POST /api/pads/:id/opened` records a human visit; GET, HEAD, WebSockets, and
preview requests never refresh the six-month expiry. Mutations and WebSocket
upgrades require an exact matching `Origin`.

`/api/pads/:id/ws` uses the standard binary Yjs sync and awareness framing.
`protocol.ts` exports the browser-safe framing constants and helpers. Message
4 carries a client update ID and update bytes; message 5 acknowledges that ID
only after commit, and message 6 rejects it with a stable code. Standard sync
updates also pass through the same validation and persistence pipeline. A
read-only provider sends SyncStep1 and its own awareness, never SyncStep2.
The browser keeps unacknowledged updates durably and retries them after reconnect.

Documents contain one plain `Y.Text("text")` root. Limits are 2,097,152 UTF-16
units and 16,777,216 encoded state bytes; missing predecessors are rejected.
At most 50 people join a note and 20 WebSockets use one IP. Beyond the live
limit, the GET snapshot remains available. Server-owned awareness identities,
clocks, colors, and unverified names prevent impersonating another socket.
Readers publish presence without cursors.

Updates, compaction, deletion, and expiry serialize per note. A database
advisory lock admits one server instance; each mutation also checks its owner
fence. An update becomes visible only after its log row commits. Snapshot and
watermark changes delete covered log rows in the same transaction. Interrupted
cleanup resumes after restart.

The process counts rate limits locally. `NOTES_PUBLIC_ORIGIN`,
`NOTES_STORAGE_BYTES`, `NOTES_MAX_CONNECTIONS`, and `NOTES_MAX_OPEN_PADS` are
required admission budgets; select process limits with the pre-launch load test.
`NOTES_TRUSTED_PROXY` optionally trusts one immediate peer and its last forwarded
address. Without it, forwarding headers are ignored. The optional
`NOTES_ADMIN_PASSWORD_HASH` is reserved for moderation; without it admin is off.

Storage accounting reserves payload bytes, UTF-8 snapshot text, and fixed row
costs before committing. A fenced single writer maintains the counter in memory,
reconstructs it from durable rows at startup, and reconciles uncertain transactions
before accepting further reservations. Negative deltas release space after commit. New sharing pauses at 90%; existing updates stop at capacity.
This is an application budget: provision Postgres disk, indexes, WAL, backups,
and compaction headroom separately. `/api/status` exposes the visible pause/full
state; `/readyz` fails when the budget is full.

Focused integration tests cover real WebSockets, concurrent offline edits,
read-only rejection, awareness identity, storage/connection/document limits,
failed persistence, and SIGKILL during compaction and after commit before ACK.

## Files

`POST /api/pads/:editId/files` accepts multipart fields `key` and `file` and
returns `{key}`. Keys use 1–128 ASCII letters, digits, underscores, or hyphens.
Repeating a key with identical bytes is idempotent; different bytes return 409.
Limits: 5 MiB per file, 20 files per note, 10 upload attempts per hour/IP.
The server bounds the streamed request before parsing multipart data and checks
magic bytes independently of the provided MIME type. Supported formats are PNG,
JPEG, WebP, GIF, AVIF and PDF. SVG and other active content are refused.
`GET /api/pads/:id/files/:key` accepts either capability. Raster images display
inline; PDFs download as attachments. Responses carry checked MIME types, safe
filenames, nosniff, no-referrer and no-store. Uploads reserve storage before
commit and serialize with deletion; image resizing belongs to the client.

## Website and link previews

The production entrypoint serves the built SPA from `dist/`, alongside the API
and WebSocket. Build outputs are enumerated at startup; source maps are not
served. Unknown API or asset paths return 404. Shared pages insert escaped
Open Graph text into the `<!--og-->` marker of the same index file. The
canonical URL remains the requested link; the image URL always uses the read
link. Inactive notes serve the SPA error state without stale metadata.

`GET /p/:readId/preview.png` produces a 1200 × 630 PNG from local text and
numeric chart data. The renderer never receives note URLs, HTML, SVG, or image
bytes. At most one render runs at a time; other notes receive the retryable
`preview_busy` state. A process cache holds at most `NOTES_MAX_OPEN_PADS` images,
keyed by content hash. No GET or HEAD writes to Postgres or updates human-open
dates. HEAD validates access but does not render. Cache hits still check the
current note status, including deletion and blocking.
