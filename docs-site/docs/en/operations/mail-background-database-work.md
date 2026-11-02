---
title: Mail background database work
section: Operations
order: 1162
description: Understand idle synchronization writes, freshness and runtime history retention.
tags: [mail, operations, database]
updated: 2026-11-02
---

# Mail background database work

A successful folder check records a completed sync run even when no messages
changed. The resource fence, binding's last-use time and resource's last-sync
time still advance. Health and operator views therefore keep reporting the
latest successful check, including for quiet mailboxes. IMAP push heartbeats
and provider lease renewal keep their existing cadence.

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
