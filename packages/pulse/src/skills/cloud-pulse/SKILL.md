---
name: cloud-pulse
description: Inspect Pulse telemetry and guide Cloud administrators through connecting its ClickHouse data store.
---

# Pulse

Pulse records metrics, events and states in bases and displays dashboards.
Each base owns a ClickHouse database and read user. The operator provides a
dedicated ClickHouse instance; a Cloud admin connects it through Administration → Pulse
→ Data store. Without it, Pulse data APIs return PULSE_STORE_NOT_CONFIGURED; its admin routes
and other Cloud applications remain available.

Use `cld pulse admin store get` to inspect configuration, `check` to verify it,
`setup-sql` to obtain the operator script, and `set` to check and save a connection.
Read `cld pulse reference admin.md` for the workflow.

Never handle the ClickHouse password as a flag value, URL, chat message or log.
Use only `--password-file <path>` or `--password-stdin`. Do not read a password
file into agent context. Ask the operator to run the generated SQL as the
ClickHouse admin; the service account cannot create its own settings profiles.

Base admins manage their bases; Cloud admins set policy, limits and internal
targets. By default, people and standalone agents with write scope create bases
and become their admins. Resource-bound credentials cannot create bases.

Use `cld pulse admin policy get|set`, `bases list|limits|retry|recheck|recreate`,
`orphans list|delete`, and `targets list|add|remove`. Read the admin reference for
flags.
Internal targets are per-base host, host:port or CIDR entries; /0 is refused.
A failed lifecycle operation needs Retry. A write block after restore needs a
Cloud admin to recheck matching backups or explicitly recreate an empty store.
Shorter retention requires confirming its cutoff and affected-data preview.
