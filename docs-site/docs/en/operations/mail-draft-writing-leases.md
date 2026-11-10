---
title: Mail draft writing leases
navTitle: Mail draft writing leases
section: Operations
order: 1199
description: Offline draft recovery and person-owned writing reservations in Mail's default editing mode.
tags: [mail, upgrade, collaboration]
updated: 2026-11-09
---

# Mail draft writing leases

Mail's default lock mode reserves a draft when someone starts editing. Reading
does not acquire a lease. One person's tabs, popouts, and devices share the
lease; revision checks still protect concurrent edits from that person.
Permission checks and explicit takeover stay unchanged.

The heartbeat interval remains 10 seconds and the server lease lasts three
heartbeats (30 seconds). A browser stops renewing after one heartbeat without
input or when its tab is hidden. An idle reservation therefore expires within
40 seconds of the last input; a hidden tab's reservation expires within 30
seconds. Other active tabs belonging to the same person can keep it alive.
Opening suggestions does not reserve the draft.

When several of one person's editors share a reservation, closing one editor
leaves it to expire through the heartbeat contract. It cannot release the
reservation beneath another active editor. A renewed or shared acquisition
receives the full lease lifetime.

A failed heartbeat keeps the local editor writable. The save status distinguishes
pending input, device storage, and confirmed server storage. On reconnect, Mail
uses the original revision and never replaces another writer's text silently.
When someone else holds the lease, local input remains available for copying
and explicit recovery. A conflicting save creates a recovery copy. Local
journals retain their existing 24-hour expiry and account isolation.

No migration, environment variable, or operator action is required. Deploy Mail
with its matching browser assets. Older open clients keep their previous
heartbeat behavior until reloaded. Shared Yjs draft mode is unchanged.
