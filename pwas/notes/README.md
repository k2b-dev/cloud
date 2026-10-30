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
- [ ] Standard Yjs sync, durable commit before broadcast and acknowledgement.
- [ ] Recovery across crashes and concurrent compaction.
- [ ] Independent read/edit links, write checks, connection-owned awareness.
- [ ] Text, state, connection, rate, and total storage limits.
- [ ] Checked image/PDF files in Postgres.
- [ ] Explicit human-open signal and six-month expiry.
- [ ] Reports, password-protected moderation, and decision log.
- [ ] Escaped link metadata and a network-free 1200 × 630 preview.
- [ ] SPA/API/WebSocket image and graceful shutdown.

Run the integration files through the repository test runner with
`CLOUD_TEST_DATABASE_URL`. The shared fixture refuses databases whose names
do not end in `_test`; each file creates and drops its own database.
