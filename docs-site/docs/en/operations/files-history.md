---
title: Files history
navTitle: Files history
section: Operations
order: 1560
description: Understand recorded folder creation, uncertain outcomes, and history retention in Files.
tags: [operations, files, history, retention]
updated: 2026-10-20
---

# Files history

Files records folder creation in `filesv2.activity`, including the person,
channel, request context, and path. Web, app, API/CLI, capability, and batch
folder creation use the same service. Later steps extend history to other
changes.

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
`detail.observed_after`. Unreadable configuration or unavailable storage gives
an unavailable observation. Recovery cannot mark folder creation done from
appearance. A late successful response can still replace `unclear` with
`done`.

Unclear entries become final seven days after their start: they stay unclear,
receive `detail.final = true`, and stop being scheduled. They still expire
under the retention policy. Recovery never overwrites done, failed, or
not_done outcomes.

## Keep every write guarded

Only `service/filegate-facade.ts` holds Filegate SDK clients. Its derived
clients keep the same guard. Folder creation needs an open activity scope
matching the server, root, action, and path. Missing, closed, or mismatched
scopes fail before a request is sent.

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
