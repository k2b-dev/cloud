---
title: Mail background database work
navTitle: Mail database work
section: Operations
order: 1162
description: Understand idle synchronization writes, freshness and runtime history retention.
tags: [mail, operations, database]
updated: 2026-11-03
---

# Mail background database work

A folder check whose IMAP `STATUS` shows nothing new ends without a commit:
it claims no resource fence and records no sync run. That needs a server with
CONDSTORE, a folder whose import finished with no flag walk, reconciliation
or search under way, a full reconciliation less than six hours old, and
settled stored state: an active binding and connection without errors and an
active resource and mailbox health. The resource's last-sync time still moves
on, at most once a minute, so health and operator views keep reporting a
recent check for quiet mailboxes. The binding's last-use time follows
committed batches only.

Completed sync runs in operator counts and `cld mail sync runs` therefore
show batches that changed something. A failed check still records a failed
run. The Drafts folder, servers without CONDSTORE, a folder whose stored state
needs recovery, and every folder a waiting `sync` command asked for still take
a full batch with a completed run. IMAP push heartbeats and provider lease
renewal keep their existing cadence.

Each Mail process logs `Mail folder sync activity` every ten minutes in which
folder syncs ran. It counts sync requests by trigger (`scheduled`, `push`,
`reconcile`, `command`, `maintenance`, `mailbox`, `continuation`, `busy`,
`rate_limited`) and batches by outcome (`committed`, `unchanged`, `deferred`,
`failed`). A coalesced job keeps the input of its first request, so requests
are counted when they are made.

An unchanged folder cursor, folder sync status, mailbox health or connection
error state no longer causes a row update. Binding-folder UID state is updated
only when UID validity, next UID or highest modification sequence changes;
its `last_verified_at` follows that state update. It is not the binding
verification timestamp used for rediscovery. Changes, error recovery and
completed reconciliation windows are still recorded immediately.

The mailbox and connection `updatedAt` timestamps now follow actual metadata
changes. Idle checks no longer move a mailbox forward in lists ordered by its
last update; sync freshness still comes from the resource's last-sync time.

Completed sync runs are retained for 30 days. The hourly runtime-history
cleanup leaves running rows alone and removes expired terminal rows in
1,000-row batches, with at most 100 batches and a five-second budget per run.
A backlog can outlast 30 days; this is an age policy, not a fixed table-size
limit. No migration deletes history or reclaims disk space. Investigate a
persistently growing backlog before changing retention or scheduling a
separate database maintenance operation.

After deployment, compare interval deltas in `pg_stat_user_tables.n_tup_upd`
for `folders`, `binding_folder_refs`, `provider_connections` and `mailboxes`
in the `mail` schema. Compare them with completed `mail.sync_runs` counts for
the same period and `pg_stat_statements` calls for the corresponding updates.
Calls still occur to validate and lock current state, but unchanged rows are
not rewritten. Cumulative production totals include older versions.
