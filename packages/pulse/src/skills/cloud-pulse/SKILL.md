---
name: cloud-pulse
description: Inspect Pulse telemetry and guide Cloud administrators through connecting its ClickHouse data store.
---

# Pulse

Pulse records metrics, events and states in bases and displays dashboards.
Existing features currently use Postgres. The operator provides a dedicated
ClickHouse instance; a Cloud admin connects it through Administration → Pulse
→ Data store. In this release, connecting prepares the store for later slices;
Pulse keeps working without it.

Use `cld pulse admin store get` to inspect configuration, `check` to verify it,
`setup-sql` to obtain the operator script, and `set` to check and save a connection.
Read `cld pulse reference admin.md` for the workflow.

Never handle the ClickHouse password as a flag value, URL, chat message or log.
Use only `--password-file <path>` or `--password-stdin`. Do not read a password
file into agent context. Ask the operator to run the generated SQL as the
ClickHouse admin; the service account cannot create its own settings profiles.
