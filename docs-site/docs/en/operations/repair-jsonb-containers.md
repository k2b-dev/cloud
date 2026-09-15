---
title: Upgrade encoded JSON metadata
navTitle: JSON metadata upgrade
section: Operations
order: 1115
tags: [database, maintenance, json]
updated: 2026-09-15
description: Understand automatic JSON metadata repairs and discarded legacy records during upgrade.
---

# Upgrade encoded JSON metadata

Older writers could store objects or arrays as JSON strings inside JSONB columns.
The corrected writers and application startup migrations handle the production
upgrade from revision `9ab9ec45c614` (June 23, 2026). A separate repair command is
not required for this upgrade.

Before starting updated services, back up PostgreSQL and stop the old Core,
application replicas, and background workers together. Start updated Core first,
then the updated applications. Keep old writers stopped: they can recreate the
incorrect values. Repeated startup preserves repaired records and valid new data.

This JSON metadata change does not complete the rest of the release upgrade.
Prepare NATS JetStream, Core's identity-key encryption key, and the Core/OAuth
broker secret when running OAuth. Follow [Deployment requirements](/en/docs/operations/deployment-requirements),
[Runtime configuration](/en/docs/operations/runtime-configuration), and the
[coordinated identity and OAuth migration](/en/docs/reference/deprecations-and-migrations#jwt-only-sessions-and-internal-invocations)
before restoring traffic.

## What startup changes

| Data | Upgrade behavior |
| --- | --- |
| Deleted-account metadata and audit metadata | Decode valid encoded objects in PostgreSQL, preserving numeric precision and original timestamps. |
| Venue public-section content | Decode valid encoded objects without changing section identity, content precision, or timestamps. |
| Tools webhook logs | Delete logs with invalid header container types. Keep endpoint configuration and valid logs. |
| Gateway registry snapshots | Delete snapshots with invalid metadata container types. Live discovery rebuilds them during startup. Keep valid snapshots and health-webhook configuration. |
| Notification batch selections | Clear invalid selections and cancel affected draft, ready, or running batches before delivery starts. Preserve completed delivery history and valid batches. |

For the lossless repairs, malformed JSON, unsupported Unicode, numeric overflow,
and unexpected value types remain unchanged without aborting startup. Preserved
values may still need individual review before their contents can be used. Venue
shows malformed JSON or non-object section content as empty content instead of
failing the page request; the stored original remains available for review.

Existing log records remain in place and are read through the compatibility
reader. This metadata repair neither resets nor migrates identity keys. AI, Assistant, and Capabilities repairs
belong to the separate local development scope; they are not required for the
production baseline above.

## Optional diagnosis

The checkout's maintenance script can inspect an explicitly supported table:

```sh
bun --no-env-file scripts/repair-jsonb-containers.ts --table audit.events
```

Supply `DATABASE_URL` through the intended database's secret environment. The
command prints counts without metadata or credentials and writes nothing unless
`--apply` is supplied. Its target list is broader than the automatic production
upgrade; inclusion is not an instruction to repair every listed table.

For a separately approved repair, confirm the table, backup, and recovery path
before adding `--apply`. The tool commits batches of at most 500 rows, skips
already corrected values, and avoids overwriting concurrent changes. Validation
errors stop the current batch; earlier batches remain committed. Scalar-valued
workflow results, AI accounting aggregates, and other fields outside its explicit
target list need their own review.
