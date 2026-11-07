---
title: Grids events
navTitle: Grids events
section: Reference
order: 540
description: Version 1 record events, their references, mutation boundaries, and bulk summaries.
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

Each individual record event has `subject: { type: "grids.record", id }` and
`place: { type: "grids.base", id }`. Both IDs are the six-character public IDs
accepted by the Type readers. The version describes the event contract, not
the record revision. `data` is a strict empty object (`{}`): events contain no
field values, field names, relation targets, actor identities, or snapshots.
Read current content through authorized Grids capabilities. A deleted record's
subject remains a reference; it does not make the trashed record readable.

Grids writes the event to the platform outbox in the **same transaction** as
the record change. Rollback removes both. Within the individual event budget,
each committed change produces one outbox event; delivery is at least once, so consumers must deduplicate by event
ID. An event is a notification of a change, not a snapshot for evaluating a
historical filter. Several later changes may already have committed when a
consumer reads the record.

Resource events reach only mandate-bound workload subscriptions with current
read access to the base. Ordinary application subscriptions do not receive
them. See [App events](/en/docs/platform/app-events) for envelopes, resource
visibility, ordering, activation cutoffs, and retries.

## Bulk changes

The first **10,000 record changes per base per transaction** each produce an
individual event. The budget counts creation, updates, deletion, and
finalization across that base's tables. Repeated changes to one record count
separately; unchanged or rejected writes do not consume the budget.

Further changes **still commit**. For each table with overflow changes, Grids
publishes exactly one version 1 `grids.records.changed` summary at commit:

```json
{
  "subject": { "type": "grids.table", "id": "Table1" },
  "place": { "type": "grids.base", "id": "Base01" },
  "data": {
    "counts": { "created": 2, "updated": 4, "deleted": 0, "finalized": 0 }
  }
}
```

This shows the reference and data fields of the standard event envelope.
Counts cover only changes beyond the individual event budget, grouped by
kind. No record IDs, field values, snapshots, or arrays are included. The
summary's size does not grow with the number of changed records. Subscribers
must re-read the table through authorized capabilities to reconcile its
current state; they cannot use a summary to recover individual historical
changes. Rollback, including rollback to a savepoint, discards the associated
counts and events. There is no event-budget error and no need to split an
existing write transaction.

A transaction emits at most 10,000 individual record events per base plus one
summary per table with overflow. There is no rate throttle across transactions.
The 10,000 budget matches the maximum public GQL result size; it bounds
individual event fan-out, not domain writes. Operators must include both
individual events and summaries in capacity planning; see
[Operate app events](/en/docs/operations/app-events#plan-retention-and-outage-capacity).

### Import and bulk write boundaries

The public `records import` API accepts 1–500 records and commits each request
atomically. The documented CSV conversion recipe produces those batches;
Grids has no native CSV or XLSX import endpoint. The internal `createMany`
service accepts larger arrays in one transaction and uses overflow summaries
when needed. External-identity batches accept up to 100 items and commit each
item independently. An unchanged retry emits no update event.

Update and delete APIs write one record per transaction. Bulk workflows invoke
those operations through existing transactional actions; `atomicRecords`
accepts up to 50 changes. Services that combine record writes in a caller-owned
transaction share its per-base event budget. These existing write boundaries
are unchanged.

## Table and base lifecycle

| Full event type | Version | Subject | When it is published |
| --- | --- | --- | --- |
| `grids.table.deleted` | 1 | `grids.table` | A table moves to trash. |
| `grids.table.restored` | 1 | `grids.table` | A table is restored. |
| `grids.base.deleted` | 1 | `grids.base` | A base moves to trash. |
| `grids.base.restored` | 1 | `grids.base` | A base is restored. |

Each lifecycle change produces **one event**, with the base as `place` and
strict empty `data`. Table and base deletion hide their children without
individually tombstoning records; restoration makes the surviving children
reachable again. Children trashed independently remain trashed. Neither
operation fans out record events or consumes the record event budget,
regardless of the number of descendants. Subscribers should re-read the
parent and its tables when they regain authorized access. A deletion event
does not make a trashed parent readable.

## Changes outside this event contract

Restoring a record, adding a comment, recalculating derived caches, and changing
schemas or presentation do not publish individual record events. Relation-link
replacement changes only its source record; soft-deleting a relation target
does not cascade record writes. Foreign-key cleanup on physical deletion
removes links without turning referencing records into record mutations. Combined tables
receive their existing live refreshes but do not publish duplicate resource
events for their source records. Existing Grids live updates and internal
workflow snapshots keep their own contracts.
