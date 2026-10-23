---
title: Operate machine file storage
navTitle: Machine file storage
section: Operations
order: 1250
description: Provision, preserve and recover independently owned Files storage for machine accounts.
tags: [operations, files, storage, service-accounts]
updated: 2026-10-23
---

# Operate machine file storage

Files supports independent Cloud storage for agents and standalone service
accounts. Configure the Cloud area and Filegate connection in Files settings,
then create a binding and explicit grants under **Machine storage**. See
[Files machine storage](/en/docs/identity/files-machine-storage) for permissions
and API requests.

Directories use `machine-<account UUID>` under the configured Cloud homes
location. Filegate uses its existing service execution identity, independently of local
Linux identity provisioning. This feature
adds no operator UID range, account allocator or human impersonation rule.
Ownership claims survive account deletion and prevent path reuse. The human
account lifecycle scanner does not archive these directories.

Back up the Files database together with the existing Filegate data and state.
Machine ownership, exact storage bindings, path grants and upload reservations
are durable database state. Expiring transfer tickets contain encrypted gateway
lease information; preserve the existing Cloud secret encryption key when
restoring the database. A gateway or path change does not silently rebind a
machine's storage. Restore the recorded configuration before retrying a pending
operation, and reconcile a migration explicitly.

Machine transfers pass through Cloud so each new request can check account and
grant state. Keep the normal gateway request cancellation and upload streaming
configuration. Filegate's existing transfer and session budgets still apply;
this feature adds no alternate storage quota policy. Already admitted streams
can finish after revocation; subsequent requests and upload publication are
denied.

FreeIPA machine access stays denied without a supported independently
provisioned machine Unix identity. Do not assign a human UID to work around
`identity_incomplete`. Machine Unix provisioning and authoritative UID ownership
must be agreed before implementing that integration.
