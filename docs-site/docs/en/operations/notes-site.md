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
