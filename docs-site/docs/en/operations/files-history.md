---
title: Files history
navTitle: Files history
section: Operations
order: 1560
description: Understand recorded file transfers, folder creation, uncertain outcomes, and history retention in Files.
tags: [operations, files, history, retention]
updated: 2026-10-22
---

# Files history

Files records folder creation, renames, moves, and copies in
`filesv2.activity`, including the person, channel, request context, and both
paths for a transfer. Web, app, API/CLI, capability, and batch calls use the
same service. A moved folder produces one row for its whole tree; batch rows
share an ID. Copies retain both storage bindings and roots, plus the actual
returned destination path and identity. Copies take the existing source-root
publication lock, then resolve the source again. This keeps another Cloud
writer from replacing the source between recording its identity and copying
it. This lock covers the entire Filegate root, including other users and
groups. A large copy can hold it for the duration of the transfer (up to the
ten-minute call budget). Other publications wait up to five seconds, then
return the existing retryable `operation_busy` error. Copies can likewise
return busy while another publication holds that root. External writers and
a lost lock lease remain outside this coordination guarantee. Later
steps extend history to other changes.

An independently committed `pending` row precedes the Filegate write. Only a
successful response and committed finish mark it `done`. A certain refusal
with no change marks it `failed`, also when recovery already recorded
`unclear`. A missing response remains `pending` until
recovery records `unclear`. Finding the expected folder cannot prove who
created it. `not_done` is reserved for checks that can prove no change; folder
recovery never uses it.

## Retain history

Administrators set `activityRetentionDays` in the Files configuration. The
default is **365 days**; the allowed range is **30–3650 days**. Older saved
configurations use the default.

Maintenance runs every minute. Each run purges at most **10,000** expired rows,
using their start time. Pending rows are kept regardless of age. If the saved
configuration is unreadable, purging stops until it can be read again.

Account deletion sets `actor_user_id` to null and retains the entry. History
stores no person's name snapshot. Binding IDs have no foreign key: deleting a
storage binding must not erase its history.

## Recheck uncertain writes

A running write renews its heartbeat every 10 seconds. Maintenance claims at
most 50 due entries whose heartbeat is more than 60 seconds old, skipping
locked rows. Rechecks wait 1 minute, 5 minutes, 30 minutes, then 6 hours between
attempts. Staleness, the seven-day limit, and retention use the database
clock, so clock drift on an app host cannot make a running write look stale.

For folder creation, a recheck records only what storage currently shows in
`detail.observed_after`. Transfers additionally record `detail.observed_before`
and check the destination root separately. Same-root moves and copies have no
retained Filegate transfer receipt. Even a missing source and present target
cannot establish completion. For a copy whose name was chosen after a
conflict, recovery can inspect only the originally intended path.
Unreadable configuration or unavailable storage gives an unavailable
observation. Recovery cannot mark these operations done from appearance. A late successful response can still replace `unclear` with
`done`.

Unclear entries become final seven days after their start: they stay unclear,
receive `detail.final = true`, and stop being scheduled. They still expire
under the retention policy. Recovery never overwrites done, failed, or
not_done outcomes.

## Keep every write guarded

Only `service/filegate-facade.ts` holds Filegate SDK clients. Its derived
clients keep the same guard. Folder creation needs an open activity scope
matching the server, root, action, and path. Missing, closed, or mismatched
scopes fail before a request is sent. Transfers additionally match the exact
source and destination paths, destination root, move/copy mode, and conflict
policy. The finish records only a completed response at the intended path
(or a sibling selected by the requested rename policy).

Activity scopes and write accounting stay private to the history module. The
facade asks that module to check each mutation; callers can read only the
activity ID. The guard uses a copy of the committed intent, so changing the
caller's object cannot redirect an authorized write. The temporary migration
permissions are immutable as well.

Unconverted writes use named `PENDING_MIGRATION` entries. That list may only
shrink. Each entry permits only its listed facade methods, and the number of
places that use an entry may only shrink as well. A separate `lifecycle.probe` exception permits only owner-probe folder
creation and removal. Statistics refresh and index rebuild change derived
metadata and need no user-data history entry.

The `filegate-facade` repository check prevents SDK access outside the facade.
The activity classification test detects new service methods and migration
keys that have not been reviewed.

## Interpret changes discovered on contact

Files compares the current item with the last confirmed Cloud change when the
item is opened, before a document save, and during maintenance. It records a
changed revision or size, a missing item, or a stable ID found at another path.
The entry gives the time Files noticed the difference. It does not identify who
changed the item, when the change happened, or what caused it.

This comparison needs a retained, confirmed Cloud entry. It creates no baseline
from a first read and makes no claim while a related Cloud operation is pending
or uncertain. Repeated contact with the same difference produces one entry.
Without stable IDs, an external move can only appear as a missing item. Without
a revision, a same-size content change can go unnoticed. Files cannot reconstruct changes that it never saw.

## Export history for administration

Administrators can download CSV or JSON Lines through
`GET /api/filesv2/admin/activity/export`. Pass `format=csv` or `format=jsonl`, and
inclusive UTC dates as `from=YYYY-MM-DD&to=YYYY-MM-DD`. Optional `baseId`,
`actor`, `action` and literal name/old-path search `q` filters narrow the export. Current administration rights
are checked before reading and again before authorizing the download.

The same parameters on `GET /api/filesv2/admin/activity/export/preview`
return a row count for the export dialog without starting a download. The
download recounts its own snapshot; concurrent changes can alter the estimate.

An export covers at most one calendar year and 100,000 entries. A wider range
or larger result returns `413` before any file bytes; narrow the dates or add a
filter. Counting and streaming use the same database snapshot, so changes made
during the download cannot shift its pages. CSV cells are quoted and protected
against spreadsheet formulas.

Each authorized export is recorded in the security audit before streaming
starts. The audit records the filters and selected row count, not a claim that
the download completed. Canceling a download stops the export and releases its
database snapshot; its audit evidence remains. A failed or interrupted stream
is incomplete and should be discarded before requesting a fresh export.

Exports contain file names, paths and the names of accounts that still exist.
Protect the downloaded file separately: Files retention cannot delete copies
an administrator has downloaded. Operators should agree access and retention
with the responsible privacy representatives, including a works council where
applicable, before using history in a workplace.
