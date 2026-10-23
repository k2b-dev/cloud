---
title: Operate machine group management
description: Provision and revoke independent local group managers.
---

# Operate machine group management

The Core migration adds a separate machine-manager relation. Existing memberships
and human management assignments keep their behavior; migration grants no machine
new management rights.

Create an active standalone or agent account, issue a key with `write` scope, and
add that account to a local group's **Managers** in Accounts. Keep the key in the
consumer's secret store. For name resolution, configure only the directory shares
that consumer needs. Granting management authorizes membership changes, including
changes that affect resources shared with that group; choose the group accordingly.

Remove the management assignment to stop that workload managing the group. Disable
the account or revoke its key to stop all its authenticated requests. The system
checks current rights transactionally; it does not require a cache flush or restart.
Review `accounts.group.member.add` and `accounts.group.member.remove` audit events
by `metadata.actorServiceAccountId`, `credentialId`, and group target. Failed
requests remain visible as denied or failed events. A committed membership change
survives a later revocation.

See [Machine group management](../identity/machine-group-management.md) for the
API contract and exact limits. Human-only account administration and FreeIPA
management remain separate.
