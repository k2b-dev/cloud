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

## Storage and administration

Provisioning, archiving, restoring, and retiring storage produce history.
Automatic provisioning names the person whose request required the storage,
with the system channel; automatic archiving names the system. Retries keep
the original actor and request context. The operation journal, history intent,
and exact allowed parent-folder creation options commit before storage changes.
Completion updates the journal, history, and security audit in one transaction.
A returned storage receipt can finish a retried operation. A folder appearing
at an ordinary create or restore destination cannot establish completion.

Adopting an existing storage binding writes its security audit in the same
transaction as the binding. Template creation, import, content or metadata
changes, removal, and access grants and revocations also commit their security
audit with the change. Configuration updates and resets do the same, without
putting credentials or configuration values in the audit event.

Creating or revoking a public link records one history entry per selected
top-level item and a security event in the transaction that changes the link.
Revoking a link still works when its creator has lost access to its original
folder. The recorded paths describe the original selection; they do not grant
access to the history reader. Repeating a revocation produces no second event.

## Public-link and administrative reads

Files records administrative folder listings, downloads released to the
administrator, and version listings in history and the security audit before
returning the result. Ordinary signed-in listings, searches, previews, and
downloads do not create read-history events.

For public links, Files counts page views, released downloads, and failed
password attempts. A download count means that Files released a download or
archive lease; Filegate does not report whether the visitor completed it.
Internal share-management listing does not increment the public counters.

Only shortened networks are stored: IPv4 /24 and IPv6 /48. Browser names come
from a fixed family list, with no stored user-agent string. Each link and hour
keeps at most 100 distinct networks, then uses an overflow bucket. A network
is not a person. After 30 days, maintenance replaces those buckets with daily
counts without networks or browser families. Daily counts expire under the
configured history retention. One maintenance call handles at most 10,000
source rows across aggregation and deletion.

A definitive refusal of directory publication or a same-root move leaves the
original operation retryable. A missing response keeps it unresolved. Recursive
permanent deletion can remove part of a tree before failing, so its refusal is
not treated as proof that nothing changed. Existing unfinished operations from
before this rollout receive an adopted history entry with their original
actor and dates. An ordinary create or restore target, or a missing delete
source, cannot prove their completion; such operations remain unresolved.
