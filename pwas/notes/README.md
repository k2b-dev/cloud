# k2b notes server

This standalone Bun/Hono service uses its own Postgres database. It does not
register with Cloud and needs no Core, gateway, or NATS. Its platform client
initialization requires a Valkey URL (`REDIS_URL`); note data stays in Postgres.

Run `bun run --cwd pwas/notes start` with `DATABASE_URL` pointing at the Notes
database and `REDIS_URL` set to the installation’s Valkey endpoint. Startup applies the versioned SQL migrations in one transaction.
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
- [ ] Escaped link metadata and a network-free 1200 × 630 preview.
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

File requests share a process concurrency budget of `NOTES_MAX_OPEN_PADS`
transfers. Admission and edit-link checks happen before reading upload bodies.
Body reads are cancelled on disconnect or after one 30-second heartbeat interval,
so stalled uploads release their slots. Excess transfers return 503
`transfers_full`; clients can retry.

## Reports and moderation

`POST /api/reports` accepts `{linkId, reason, text, email?, confirmed:true}`.
Reasons are `abuse`, `illegal`, `copyright`, `privacy`, or `fraud`; the specific
explanation has 10–10,000 characters. The response carries an intake `number`.
Ten report attempts per hour and five admin logins per 15 minutes are allowed
per connection; they have independent windows.

`admin/AdminPage.tsx` supplies the SPA's `/admin` view. It inherits the UI locale
and supports German and English. Set `NOTES_ADMIN_PASSWORD_HASH` to an Argon2id
hash from `Bun.password.hash`. Without it all admin endpoints are disabled.
A session lasts 12 hours, rotates on login, and is stored as a hash in Postgres.
The `__Host-notes-admin` cookie is Secure, HttpOnly, SameSite=Strict, and Path=/.
Password rotation invalidates previous sessions. Expired sessions are pruned in
bounded batches.

The admin API starts with `GET /api/admin/session` (`authenticated`, `csrf`).
`POST /api/admin/login` takes `{password}`; it also requires the pre-login
cookie and `x-csrf-token` from the session response. All admin mutations require
the configured Origin, the session cookie, and `x-csrf-token`. `logout` ends the
session. `GET /api/admin/reports?before=<number>` pages through 50 reports;
`GET /api/admin/status` shows storage and maintenance failures.
`POST /api/admin/reports/:number/decision` takes
`{action:"keep"|"block"|"delete", reason}`. Repeating an identical decision is
idempotent; changing it returns 409. Decisions and reasons are audited, affected
sockets close, and blocked/deleted content is removed atomically. Owner deletion
and expiry also produce audit entries. Tombstones retain only capability lookup data,
status and dates for the gone/blocked response.

When the reporter provided an email, the decision stays visibly pending. The
operator prepares and sends the email using the admin view, then explicitly
confirms it through `POST /api/admin/reports/:number/notified`. Preparing an email
is not recorded as delivery. Notes requires no mail server or mail credentials.
Before public launch, name the responsible moderator and deputy and agree the
appeal and authority-reporting process with legal counsel.

Administrative sessions, decisions and removal audits remain available when the
application budget is full. Their bounded records are still accounted for and
may exceed the application threshold so the operator can free storage. Public
note creation, uploads, reports and updates remain subject to their thresholds.
