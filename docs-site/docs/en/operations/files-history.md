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

## Read visible history

The Files history API, `cld filesv2 history`, and the `activity.list`,
`activity.get`, and `activity.chain` capabilities use the same permission-aware
reader. Reading history never provisions storage or adopts a new binding.
Group management grants no additional history access.

Each side of a change is checked separately against current membership,
filesystem read permissions, and stable identity. A readable old parent can
show that an item disappeared, its old name, actor, and time. The destination
remains hidden unless it passes its own check. Without stable identities,
other people's entries expose only these minimal fields. A disappearance side
also carries `directory` (null for unknown legacy metadata) and `publicBaseId`
(null unless current access establishes that base). It carries no item ID,
size, revision, or later observation. Own actions retain
their recorded snapshots; those snapshots do not authorize navigation to a
current location. Administrators can read recorded snapshots across bases.
Names are resolved from live accounts; deleted accounts have no retained name.
Fully visible `share.create` and `share.revoke` entries include
`share.expiresAt` from the retained share. Null means no recorded expiry or a
missing share row. Disappearance-only entries carry no share metadata.

Search and counts use only the projected fields. A page returns at most 50
visible entries after inspecting at most 500 candidates. An empty page may
still have a next cursor. Search stops after 200 visible matches. Keep filters
unchanged when following a cursor. Movement chains follow path segments for at
most 20 steps. A current endpoint is verified with stable identity and fresh
read permissions, or explicitly marked probable when only path evidence is
available. Chains never claim complete history across retention gaps.

`GET /api/filesv2/activity/:activityId/chain` also accepts `oldPath`, the
opened old address relative to its base. For example, a move of `Customers`
can locate `Customers/Proposal.pdf` without a separate history row for that
file. The old path must match the visible before-side or descend from that
directory on a slash boundary. Absolute paths, empty or dot segments,
backslashes, control characters and `.filegate` segments are rejected;
unrelated addresses return 404.

A descendant inferred from a folder move is always `probable`. The folder's
stable ID never identifies its child, and the result grants no move-back
authority. Later recorded child and ancestor moves continue the same chain;
copies, replacements, deletions and truncated path evidence prevent an
endpoint. A returned endpoint requires current membership, binding, server,
traversal and leaf read checks at that child's current address. Saved own
snapshots do not grant those rights. Opening an old folder address shows its
own name and an explicit jump action; it never redirects automatically.
Omitting `oldPath` keeps the existing exact-item chain behavior.

Only a public link's creator and current administrators can read its access
counts and shortened networks; a current full user profile is required.
The access result repeats the selected inclusive UTC dates as `from` and `to`.
Its `pages`, `downloads`, and `passwordFailed` totals cover the whole period,
independently of either page cursor. Networks are shown only for the last 30 days,
even while maintenance has a backlog. Overflow gives a lower bound, and daily
rollups provide no network identities or counts. Counters measure released
downloads, not completed transfers.

Networks are ordered by page plus download counts, descending, with canonical
network keys breaking ties. Password failures do not influence that order.
`networks.incomplete` means the known count is only a lower bound: expired,
rolled-up, overflow, or unclassified accesses prevent an exact period count.
For a sentence such as “96 page views from 21 networks”, use `pages` and
`pageNetworks`: the latter counts only networks with page views, excluding
download-only and password-only networks. It is null when those page-view
identities are incomplete; then show the page count without an exact network
count. Follow `networks.next` with `networkAfter` and the same dates;
an expired cursor returns `share_access_cursor_expired`/409. Refresh the first
page. Ordering uses current totals, so concurrent access can reorder networks.

`timeline.items` returns up to 50 latest UTC aggregates with `date` (bucket
start), `granularity` (`hour` or `day`), `pages`, `downloads`, `passwordFailed`,
`knownNetworks`, and `overflow`. These are bucket times, never individual
request times. Hourly rows cover at most the last 30 days. Older data appears
as daily rows, including while rollup is pending. If any part of a UTC day has
expired or already rolled up, that whole day's timeline row uses daily
granularity. `knownNetworks` is null for daily rows and unclassified hourly
accesses; otherwise it counts known networks, with `overflow` marking a lower
bound. Daily rows retain no overflow evidence. Follow `timeline.next` with
`timelineAfter` and the same dates to read older aggregates. Both cursors are
independent. Reads create no activity or audit action.

Administrators use `GET /api/filesv2/admin/activity/bases?q=…&after=…` for
history filter labels. It returns `{items:[{id,name,kind}],next}` with at most
50 public base IDs, including archived recorded bindings. Names come from
current accounts; deleted users are labeled “Deleted account”, while missing
groups use the recorded base name. Search matches the displayed name or ID,
examining at most 500 identities per request; an empty page can have `next`.
Pass that public base ID unchanged as `after`. This read checks current
administrator rights on every page and never inventories or provisions
storage. The ordinary `/activity/bases` membership list is unchanged.
