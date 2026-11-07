---
title: Grids events
navTitle: Grids events
section: Reference
order: 540
description: Version 1 record events, their references, mutation boundaries, and bulk limits.
tags: [grids, events, records]
updated: 2026-11-07
---

# Grids events

Grids publishes resource events for committed changes to stored records,
including changes through the API, capabilities, imports, and bulk services.
Publication does not require an enabled workflow or a subscriber.

| Full event type | Version | When it is published |
| --- | --- | --- |
| `grids.record.created` | 1 | A stored record is created. |
| `grids.record.updated` | 1 | Stored field values or ordered relation targets change. An unchanged update emits nothing. |
| `grids.record.deleted` | 1 | A record moves to trash. Repeating deletion emits nothing. |
| `grids.record.finalized` | 1 | Finalization commits the record's durable revision and finalization marker. This emits no additional `record.updated` event. |

Every event has `subject: { type: "grids.record", id }` and
`place: { type: "grids.base", id }`. Both IDs are the six-character public IDs
accepted by the Type readers. The version describes the event contract, not
the record revision. `data` is a strict empty object (`{}`): events contain no
field values, field names, relation targets, actor identities, or snapshots.
Read current content through authorized Grids capabilities. A deleted record's
subject remains a reference; it does not make the trashed record readable.

Grids writes the event to the platform outbox in the **same transaction** as
the record change. Rollback removes both. Each committed change produces one
outbox event; delivery is at least once, so consumers must deduplicate by event
ID. An event is a notification of a change, not a snapshot for evaluating a
historical filter. Several later changes may already have committed when a
consumer reads the record.

Resource events reach only mandate-bound workload subscriptions with current
read access to the base. Ordinary application subscriptions do not receive
them. See [App events](/en/docs/platform/app-events) for envelopes, resource
visibility, ordering, activation cutoffs, and retries.

## Bulk changes

A bulk operation produces one event per changed record, without coalescing or
silently dropping records. Repeated changes to the same record in one
transaction each produce their own event. Grids allows at most **10,000 record
events per base per transaction**, budgeting one maximum-size GQL result (`limit 10000`).
The count combines creation, updates, deletion, and finalization across tables
in that base. Unchanged or rejected writes do not consume the budget.

Exceeding the budget throws an error asking the caller to split the batch;
the operation must roll back its transaction. Grids bulk services propagate
that error and roll back the entire batch, including its records and events.
Larger jobs must commit separate batches. An external-identity batch API
request retains its existing limit of 100 items and commits each item
independently; an item retry that makes no change emits no update event.
There is no aggregate rate throttle across transactions. Operators must size
retention and consumer capacity for these discrete writes; see
[Operate app events](/en/docs/operations/app-events#plan-retention-and-outage-capacity).

## Changes outside this event contract

Restoring a record, adding a comment, recalculating derived caches, and changing
schemas or presentation do not publish these four events. Trashing or deleting
a whole table or base does not fan out record deletion events. Combined tables
receive their existing live refreshes but do not publish duplicate resource
events for their source records. Existing Grids live updates and internal
workflow snapshots keep their own contracts.
