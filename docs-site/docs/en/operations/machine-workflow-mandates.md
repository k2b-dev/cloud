---
title: Operate machine workflow mandates
navTitle: Operate machine workflow mandates
description: Provision, pause, revoke and inspect automatic machine workflows.
section: Operations
order: 655
tags: [identity, service-accounts, authorization]
updated: 2026-10-23
---

# Operate machine workflow mandates

The Grids migration adds machine-owner and mandate references to workflow
profiles. Existing workflows keep their human owners. No account receives an
automatic grant during migration.

Grant the account write access to the intended base, then assign it in the workflow
editor's **Automatic execution owner** section. The administrator must also have
management access to the workflow. Grids stores a revocable mandate for that exact
workflow and a write ceiling; it stores no machine token or human session.

Pause or revoke the mandate to stop later steps and new automatic runs. Disable the
account to stop it across workflows. Removing its base grant also stops work.
Resuming a mandate does not revive queued runs accepted under an earlier mandate
revision; submit a new run after restoring authority. Review prior committed
effects before retrying a workflow with external side effects.

The workflow editor shows the account and mandate state, schedule status exposes
unavailable authority, and run history retains rejected execution. Domain audit
records contain the previous and new mandate references; platform mandate audit
records contain assignment and lifecycle operations. No restart or cache flush is
needed for revocation.

See [Machine workflow mandates](../identity/machine-workflow-mandates.md) for the
permission contract. Purely human flows and resource-bound identities retain their
separate contracts.
