---
title: Check application migration evidence
navTitle: App migration status
section: Operations
order: 1147
description: Check every application and deployed key, and verify fresh signed broker and OAuth requests.
tags: [app-keys, migration, status, operations]
updated: 2026-10-31
---

# Check application migration evidence

Use `cld admin apps migration status --strict` after upgrading all Core replicas,
Gateway and applications. It checks every live replica and sends fresh signed
broker/OAuth probes. Missing evidence returns a nonzero exit code, including
without `--strict`. There is no observation command or waiting window.

Enroll keys before upgrading to this release; see
[App key upgrade](/en/docs/operations/app-key-upgrade). Every OAuth issuer key
requires an explicit `--grant oauth:issue`, including rotations, whatever its app ID.

## Check the complete inventory

Write one intended app ID per line in `apps.txt`, including stopped and
third-party apps; exclude `core` and `gateway`. Then run:

```bash
cld --profile migration admin apps migration status --strict --json --expect "$(paste -sd, apps.txt)"
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
stopped apps or rejected starts, and never permits a keyless serving process.

JSON includes per-app `attentionReasons`, `probes` and `lastRejectedStart`.
Text output prints the same evidence. A rejected start remains an attention
reason until a successful bootstrap clears it; an older healthy process does
not clear it. `--allow-env` affects connection sources only: bootstrap mode
must still be `core` with a current app key.

Review deployed configuration and representative background jobs as well as
status. A probe does not prove that every business workflow has run.
