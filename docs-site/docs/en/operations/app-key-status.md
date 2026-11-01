---
title: Check application migration evidence
navTitle: App migration status
section: Operations
order: 1147
description: Check every application and deployed key, and observe legacy broker usage before retiring old credentials.
tags: [app-keys, migration, status, operations]
updated: 2026-10-31
---

# Check application migration evidence

Use `cld admin apps migration status` before retiring shared application environment
values or legacy broker credentials. It checks bootstrap metadata from every
live replica, sends fresh signed broker/OAuth probes, and reads a durable
legacy-use observation shared by every Core replica. Missing evidence returns
a nonzero exit code, including without `--strict`.

Upgrade **all Core replicas**, Gateway and the applications first. Enroll the
application keys and configure the applications to use them; see
[App keys](/en/docs/operations/app-keys). Every OAuth issuer key requires
`--grant oauth:issue`, including each rotation. Key enrollment never infers
a grant from an app name.

## Begin a representative observation

Only after every Core replica runs this release, explicitly start observation.
Core refuses to begin while a live Core instance lacks its legacy-evidence
capability marker. Status also reports `core_legacy_evidence_missing` for
those instances, even if a previous window was complete:

```bash
cld --profile migration admin apps migration observe --json
```

This administrator write requires OAuth `write` or `admin` scope when using
OAuth credentials. Core checks administrator access in the service and records
`app_migration.observation_begin` in the audit trail. Starting again resets elapsed time. Do not restart it while
waiting for completion. Keep older Core releases stopped for the whole window.
The capability check sees replicas live at begin and status time; it cannot
reconstruct a replica that appeared and disappeared between those checks.
If an older Core runs during the window, upgrade it and begin a new observation.

Choose the clean duration to cover the installation's actual background jobs,
OAuth issuance and infrequent callers. For example, `OBSERVATION_SECONDS=86400`
covers one daily cycle; include weekly jobs deliberately or choose a longer
interval. Exercise those paths with their new keys. Every accepted legacy
bearer or OAuth broker-secret request restarts the clean interval. Core keeps
the evidence across restarts and shares it between replicas. If it cannot
establish new evidence, the request that needs it fails and can be retried.
Requests covered by a successful evidence write continue without another
write. Core coalesces writes per legacy path for five seconds and skips row
locks held by another replica. The stored last-use time conservatively covers
that interval, so the clean window may start up to five seconds later.

## Check the complete inventory

Write one intended app ID per line in `apps.txt`, including stopped and
third-party apps; exclude `core` and `gateway`. Then run:

```bash
cld --profile migration admin apps migration status --strict --json --observation-seconds "$OBSERVATION_SECONDS" --expect "$(paste -sd, apps.txt)"
```

The inventory combines active app keys on enabled accounts, live registry
entries and `--expect`. The result includes every replica's bootstrap mode,
key ID, per-value sources and protocol/format support. Old or malformed
metadata, empty inventory, stopped expected apps and mixed replicas cannot
silently pass. Retired keys do not create expected apps on their own.

For every deployed key, Core asks the application to send a signed broker
probe. Keys with `oauth:issue` also send a signed OAuth probe. These use the
same live key/grant, admission and replay checks as signed broker requests;
they issue no token and perform no domain operation. Core requires fresh,
matching receipts. Status uses `POST /api/admin/apps/status` because probes
write receipts and key activity; OAuth credentials require `write` or `admin`
scope. Four probes may run at once, each with a 1.5-second timeout and a shared
six-second budget below the server's ten-second idle timeout. JSON reports
`probe_timeout:<keyId>` or `probe_failed:<keyId>` in attention reasons.
Missing endpoints, failed requests, deadlines or untested
keys keep status nonzero. During rotation, a service endpoint may reach the
replica using the other key; finish the rollout and retry.

`--allow-env inventory` permits that third-party app to keep explicit
connection environment values. It still needs modern bootstrap metadata,
a deployed app key and successful signed probes. The exception never waives
the observation window, stopped apps or rejected starts.

JSON includes `observation`, per-app `attentionReasons`, `probes` and
`lastRejectedStart`. Text output prints the same evidence. A rejected start
remains an attention reason until a successful bootstrap clears it; a healthy
older process does not clear it. No observation start, no chosen duration or
any missing evidence keeps the command nonzero.

A clean window cannot prove that an unexercised client has migrated. Review
the deployed configuration and representative work before removing legacy
secret injection or revoking old tokens. Keep valid rollback credentials
until the deployment no longer needs to return to environment mode.
