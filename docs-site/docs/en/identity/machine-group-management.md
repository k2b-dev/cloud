---
title: Machine group management
navTitle: Machine group management
description: Delegate local group membership changes without granting account administration.
section: Identity and access
order: 655
tags: [identity, service-accounts, authorization]
updated: 2026-10-23
---

# Machine group management

An administrator can grant an agent or standalone service account management of
one local group. In **Accounts → Groups → Managers**, add the account by name.
The picker and manager list show its account type. This is a separate grant:
joining a group never makes a machine its manager.

A machine manager can add and remove users, local groups, and eligible machine
members through `POST` and `DELETE /api/accounts/groups/:id/members`. Its token
must carry `write` or `admin` scope. A scope alone grants no management rights.
Only administrators can add or remove managers; machine managers cannot appoint
themselves, manage other groups, create accounts, or assign installation roles.
A management grant grants no directory search access. Give exact directory shares
separately when the machine needs to resolve names.

Machine management applies only to local Cloud groups. It does not authorize
FreeIPA operations or lend a person's directory or Unix identity. It is direct:
membership in a group that manages another group does not confer machine
management authority for that other group.

Remove the account from **Managers** to revoke management. Each membership change
locks and checks the current grant and active account in its database transaction.
Revocation prevents the next change after it completes. Disabling the account or
revoking its key also stops further requests. A membership change already committed
is retained; revocation does not undo prior changes.

Missing grants or write scope return `403`. Disabled accounts and revoked keys
fail authentication. Invalid member selections and cycles retain the normal
membership errors. The manager UI shows errors and leaves the current rows in
place so an administrator can retry. Audit events identify the machine and
credential in metadata alongside the group and changed member; tokens are never
logged.
