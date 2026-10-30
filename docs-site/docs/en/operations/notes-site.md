---
title: Notes website
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
