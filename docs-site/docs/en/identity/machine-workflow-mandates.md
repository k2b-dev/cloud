---
title: Machine workflow mandates
navTitle: Machine workflow mandates
description: Run automatic Grids workflows under an independent machine identity.
section: Identity and access
order: 656
tags: [identity, service-accounts, authorization]
updated: 2026-10-23
---

# Machine workflow mandates

A Grids workflow can use an agent or standalone service account for scheduled and
record-event execution. The account needs its own write grant on the base. The
workflow's mandate is an additional, revocable permission for that exact workflow;
it never borrows the editing administrator's access.

In the workflow editor, **Automatic execution owner** shows the account name, type,
and mandate state. An installation administrator who can manage the workflow may
select an active account, pause or resume its mandate, or revoke it. Group
membership alone and a credential scope alone cannot assign an execution identity.
Changing the account revokes its previous mandate. A revoked mandate is never
silently recreated; selecting an account again is a new explicit assignment.

Automatic runs store the machine principal, mandate ID and revision. Each step
checks the current account, application entry access, base grant, workflow binding
and mandate revision.
Pause, revoke, disable, reassignment, and removal of base access stop subsequent
work. A resumed mandate has a new revision, so older queued runs remain invalid.
Already committed effects are retained.

The mandate has a write ceiling. It cannot manage base access or reach another
workflow or base. Machine API invocations also retain their token's current scope,
expiry and revocation checks. Manual human invocations keep the caller's existing
permissions. Human automatic owners keep their existing behavior until an
administrator explicitly assigns a machine.

Loss of authority appears as blocked execution authority, a degraded schedule or
paused record-event trigger, and failed execution for work already queued. The
administrator can restore application access or a missing base grant, or resume a paused mandate, then
submit a new run. The editor shows failed changes and offers **Reload authority**. If another
administrator changes the owner or mandate, review the refreshed authority before
trying again. API changes include the expected account and mandate ID with its
revision, or an explicit null mandate for the first assignment; a stale snapshot
returns `409` without changing authority. Run provenance
uses the machine's name; authority changes and mandate lifecycle operations are
audited without storing tokens.

The platform mandate service accepts active `standalone` and `agent` subjects in
addition to its existing subjects. Acting for a machine requires administrative
creation authority. Grids uses the exact `workflow.run` operation for its workload;
all domain permission checks remain in Grids.
