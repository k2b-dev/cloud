---
title: Notes website
navTitle: Notes
section: Operations
order: 125
description: Run the standalone Notes server with a dedicated Postgres database and check its readiness.
tags: [operations, notes]
updated: 2026-10-30
---

# Notes website

The Notes website is a standalone service under `pwas/notes`. It uses a
dedicated Postgres database. It does not connect to a Cloud installation.

Set `DATABASE_URL` to that database and start the server:

```bash
bun run --cwd pwas/notes start
```

Startup applies the versioned migrations in a transaction. Give this database
user permission to create and alter the Notes tables. Use a separate database
from Cloud: the Notes service owns its schema and lifecycle.

On port 3000, `/healthz` returns 200 while the process is running. `/readyz`
returns 200 only when the database is reachable and every schema migration
matches this server. A failed readiness check returns 503; keep the service
out of traffic until it recovers. SIGTERM and SIGINT stop the listener and
close the database pool.

This service is being prepared for a later public launch. A working health
check does not mean that public sharing or the launch requirements have been
accepted.

## Sharing runtime

Notes runs exactly one server instance. Startup acquires a Postgres advisory
lock and installs an owner fence checked by every mutation. API writes and
WebSocket upgrades require `NOTES_PUBLIC_ORIGIN`; set it to the external HTTPS
origin. Only `NOTES_TRUSTED_PROXY` may supply the final `X-Forwarded-For`
address. Otherwise the transport peer supplies the rate-limit key.

Set `NOTES_STORAGE_BYTES`, `NOTES_MAX_CONNECTIONS`, and `NOTES_MAX_OPEN_PADS`
before startup. The latter two come from the pre-launch load test, rather than
unmeasured production defaults. The storage budget counts application payloads
and fixed row costs. Provision additional disk for indexes, WAL, backups, and
compaction. New notes and uploads pause at 90%; existing updates may use the
remaining capacity. `/api/status` exposes the pause/full states and `/readyz`
returns 503 at capacity. Rate counters reset on process restart.

The browser retains unacknowledged updates and retries them after reconnect.
The server acknowledges only committed updates, compacts covered log rows
atomically, and drains its queues before shutdown. Six-month expiry is based
on an explicit browser human-open signal. GET/HEAD, previews and idle sockets
never extend retention. Interrupted deletion cleanup resumes on later sweeps.

Before exposing the service, arrange a daily Postgres dump retained for 14 days,
verify a restore, and measure an RPO of at most 24 hours and an RTO of 4 hours.
Backup retention can outlast deletion from the running database. Keep capability
paths out of access, error, tracing, and telemetry logs at every proxy layer;
the application emits only fixed diagnostic codes.

## Moderation duty

Administration is disabled until `NOTES_ADMIN_PASSWORD_HASH` contains an
Argon2id password hash. Serve `/admin` through the same HTTPS origin as the SPA.
Sessions expire after 12 hours; changing the hash invalidates them all. Every
mutation checks Origin and CSRF, including login. Never cache admin responses.

Assign a moderator and deputy before public launch. Reports receive an intake
number. The admin view records the decision and reason, removes blocked/deleted
content, and shows pending reporter notifications. Send the prepared decision
email in the operator's mail application, then confirm it in the admin view.
This explicit delivery step needs no additional Notes mail configuration.
Storage and automatic-maintenance failures remain visible in the admin view
and fixed-code application logs. Reserve Postgres disk outside the application
budget for WAL, indexes, backups and transaction/compaction headroom.
