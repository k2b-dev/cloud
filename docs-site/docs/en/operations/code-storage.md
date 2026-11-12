---
title: Code storage
navTitle: Code storage
section: Operations
order: 1254
description: Back up Code versions and understand run retention and storage budgets.
tags: [operations, code, postgres]
updated: 2026-11-11
---

# Code storage

Core startup adds the Postgres schema `code`. Include it in the same backup
as `auth` so owner identities, service accounts, grants, versions and run
references remain consistent. The additive migration does not rewrite
Assistant chats, settings or workflow records.

Startup also adds nullable `code.calls.refusal_kind` and
`code.runs.first_refused_call_ordinal`. Existing rows remain unclassified;
there is no startup backfill or new configuration. New bridges commit a call's
classification and the first target-refused ordinal together. Keep both tables
in the same backup so that a refused call remains available after recovery,
even when the runner crashed before completing its run.

Source files and exact bundles live in Postgres with their immutable versions.
They are not container files or runner caches. Configure their admission
budgets through the `core.code.*` administrator settings documented in the
[Code data model](/en/docs/platform/code-data-model#storage-limits-and-retention).
No Code storage environment variables are required.

Administrators can change the storage budgets with
`cld admin settings apply --from ./code-limits.json --yes`. For example, this
file sets the source budget to 2 MiB:

```json
{
  "updates": {
    "core.code.source_bytes": 2097152
  }
}
```

The command uses Core's settings API, which validates the declared integer
ranges, saves the update transactionally, records the change and invalidates
cached values. Omitted settings retain their values. Use
`cld admin settings reset core.code.source_bytes --yes` to restore its default.
To explicitly replace an unreadable stored value, add
`"replaceUnreadable": ["core.code.source_bytes"]` alongside `updates` in the
JSON file. This replaces that whole value; include its new value in `updates`.
The Code keys use `settings apply`; `settings list`, `show` and `set` currently
filter Core's catalog to platform-declared settings and exclude these keys.
See [CLI administration](/en/docs/operations/cli-administration) for login.

Core sweeps at most 1,000 terminal runs per minute per replica, starting at
30 days after the run ends. It deletes their capability-call records with
them and preserves queued or running attempts. A failed sweep is logged and
retried on the next minute. Versions are retained until their Code is deleted.

Policy revisions, group rules and durable pause work share the same schema.
See [Code policy operations](/en/docs/operations/code-policy) for execution
budgets and recovery from a failed pause batch.

## Bound Code database storage

Each Code database lives in RSQL 1.1.0 or newer, separately from Postgres.
Include those SQLite databases in operator backups; a Postgres backup contains
only their mappings, versions and reservation records.

**Administration → Code → Limits** exposes `core.code.database_bytes`
(default 104,857,600 bytes, 100 MiB) and `core.code.database_owner_bytes`
(default 1,048,576,000 bytes, 1,000 MiB). The owner default allows ten databases
at the per-Code default. It is a separate setting: changing the per-Code limit
does not change the owner limit automatically. An owner is one exact person,
resource or application, regardless of who started a run.

The total counts **reserved capacity**, rather than adding potentially stale
size readings. Before creating a database or raising its ceiling, Core commits
a reservation for that database's full per-Code ceiling. RSQL enforces that
ceiling when data grows. Concurrent runs cannot reserve the same remaining
owner capacity. Ten small databases therefore reserve the default owner's
entire allowance even when they contain little data. Database size and owner
reserved capacity appear on the Code page, its administrator detail and
`cld code show <code>`.

Reservations survive outages and uncertain write results. Lowering a per-Code
limit does not reclaim an earlier reservation. Existing mappings from before
reservation accounting conservatively reserve 1 GiB each, the largest supported
per-Code ceiling; review owner limits when upgrading an installation that
already has Code databases. A lower owner limit preserves existing ceilings
and data. It refuses new reservations and quota increases, while operations
within existing reservations and exports remain available. Reads do not
request quota increases. `code_db_owner_full` explains recovery: delete unused
Code to release its database reservation, or raise the owner's limit.

## Database lifecycle

Deleting a Code or its owner uses the existing durable Code deletion job to
remove its database. Failed removals are retried; the mapping and reservation
remain until RSQL confirms removal. Changing the RSQL server URL never redirects
an existing mapping to a different server.

A database becomes unused when its Code is inactive and neither the latest nor
selected version declares `database`. Historical versions that are neither
latest nor selected do not keep it in use, unless an activation of that version
is still pending or retrying. Cloud starts a visible **30-day**
grace period at that moment. Reactivating the Code or selecting/saving a
version that declares `database` ends the period immediately. A later unused
period starts a fresh deadline. Existing unused databases receive the full
period when this feature is installed.

Owners and editors see the deletion date on the Code page. Export before the
deadline if the contents are still needed. Editors and Cloud administrators
can choose **Delete now**, with confirmation. Deletion keeps the Code and its
versions; a later database call starts with a new, empty database.

Change `core.code.database_unused_days` under **Administration › Code › Limits**
or with `cld admin settings apply --from <file> --yes`. The file contains:

```json
{"updates":{"core.code.database_unused_days":30}}
```

Zero disables automatic deletion; confirmed manual deletion remains available.
Cloud stores the deletion date and when it became visible. A new or recalculated
date is at least one reminder period (seven days) in the future, including when
you reduce retention, re-enable it or reset the setting. Code pages, the admin
list and the deletion job use that same stored date. This advance notice also
applies to resource and app owners. Changes are recalculated on the next read
or bounded scheduled pass; the notice period starts then. Last access does not
extend the deadline. Personal owners receive a notification about seven days before
deletion through their configured notification channels. Resource and app
owners have no single notification recipient; use the administrator list for
those databases.

Every five minutes, a scheduled pass admits at most 50 databases within a
ten-second budget. It rechecks current state while locking the Code, commits
the deletion intent and audit entry, detaches the old database and releases
its owner quota. An outbox removes detached databases from RSQL with bounded
requests and automatic retries, including after outages. A reactivated Code
uses a fresh database incarnation. **Cleanup** shows pending removals and retry
errors; completed removals disappear. Audit actions are
`core.code.database.deletion_requested` and `core.code.database.deleted`.
The RSQL server must remain configured until pending removals finish.

## Export a Code database

A Code editor, its owner or a Cloud administrator can choose **Export SQLite
database** on the Code page or use:

```sh
cld code db export c_1234 --out ./c_1234.sqlite
```

Both surfaces use the same permission-aware service and the namespace recorded
for that Code. Ordinary readers cannot export. A Code that has never used its
database has nothing to export; the operation never creates one.

RSQL creates a consistent SQLite snapshot. Core streams it with backpressure,
a byte ceiling equal to its reserved capacity, and a two-minute deadline;
request cancellation reaches RSQL. The CLI streams to a private temporary file
and exposes the requested output only after a complete download. Existing
files are never overwritten. A truncated or failed download reports failure
and removes its partial file. JSON and JSONL output report `codeId`, `path`,
`bytes` and `format: "sqlite"` after success.

The export covers one Code's SQLite database, not its source, secrets, access
grants or Postgres history. Keep the file private if the Code stores personal
or confidential data. There is no Code database import command.
