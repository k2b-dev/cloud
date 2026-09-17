---
title: Account administration API
navTitle: Account administration
section: Reference
order: 1276
description: Display account categories and manage Linux identities through supported APIs.
tags: [accounts, api, linux]
updated: 2026-09-09
---

# Account administration API

For application authors integrating account presentation or administrator-only
Linux identity operations. For configuration in Administration, start with
[Accounts & sign-in](/en/docs/accounts).

## Display account types in an application

Use the browser-safe `accountCategory(user)` and
`accountCategoryLabel(user, loginLabel)` helpers from
`@k2b/cloud/contracts`. Server-rendered applications obtain the label
from `readAccountCategoryPolicy()` in `@k2b/cloud/services` and pass
only the required presentation data to the browser.

Cloud's authentication layer enforces access automatically. The server-only
`isAccountCategoryAllowed(user)` checks category eligibility for platform-owned
credential flows; it does not replace authentication, expiry checks or resource
authorization. Authorization reads the durable policy without relying on the
settings cache; invalid stored policy fails closed.

## Linux identity API

### Read identities from an application

Use `accountIdentities` from `@k2b/cloud/services` for server-side reads.
Pass the authenticated request's `actor`; applications must still enforce
their route policies, credential scopes and resource permissions.

| Method | Result |
| --- | --- |
| `self(actor)` | Current user and `{ localLinuxEnabled, freeipaEnabled }` availability |
| `groups(actor, { after? })` | A page of the caller's effective groups, including nested membership |
| `inventory(actor, { kind, provider, after?, id?, name? })` | Administrator-only page of known users or groups |

Users contain `{ id, provider, username, profile, posix }`. `posix` is either
`{ uidNumber, primaryGidNumber }` or `null` when attributes are missing,
incomplete or owned by a different provider. The primary GID is the stored
primary GID; it is never inferred from the UID. Groups contain
`{ id, provider, name, gidNumber }`, including logical groups with a null GID.
An IPA user can also receive local groups through direct or nested membership.
Group management alone does not confer membership.

Reads check the current database account, expiry, category policy and provider
against the actor. Missing accounts and changed identity snapshots are denied.
Configuration reads bypass the settings cache. Disabled FreeIPA denies IPA
callers; disabling local Linux identities changes availability without removing
stored IDs. Applications that depend on local Linux identities must check
`localLinuxEnabled` before granting access to that area.

Both page methods return `{ items, nextCursor }`, with at most 50 items.
Pass a non-null cursor back as `after` until it is null. Inventory `kind` is
`"users"` or `"groups"`, and `provider` is `"local"` or `"ipa"`. Optional
`id` and `name` filters are exact matches; `name` matches the username for users.
Administrator rights are checked against current stored authority on every call.
Failures throw `AccountIdentityError` with a stable `code` and HTTP `status`.

The inventory represents identities known to Cloud. It is **not a complete
FreeIPA directory inventory**. An absent IPA identity must not be interpreted as
proof that an upstream account or group was deleted. Filesystem consumers must
inspect the filesystem separately; these reads do not track directory existence
or require directories to have been created through Cloud.

### Reconcile an identity before administrative cleanup

`accountIdentities.reconcile(actor, { kind, provider, name, identityId?, signal? })`
requires a current administrator and performs an exact identity lookup.
The optional `identityId` protects local bindings against renames or provider
changes. The result is one of:

- `{ state: "present", identity: { id, name, uidNumber, gidNumber }, eligible }`.
  Local `id` is the stable Cloud ID. An upstream FreeIPA identity has `id: null`
  because it may never have been synchronized into Cloud.
- `{ state: "absent" }` when the authoritative provider reports absence.
- `{ state: "unknown", reason }` when lookup is disabled, unavailable, invalid,
  or a local stable identity has changed its name or provider.

Local lookups read the database directly. A local full user is eligible even
when expired or its account category is disabled; those states are not deletion.
A local group is eligible when it has a positive GID. A different identity
reusing the recorded name returns its new ID, which consumers must treat as a
binding conflict.

FreeIPA uses exact `user_show` or `group_show` requests without Cloud sync group
filters. `user_show` includes preserved users; a missing user is also checked
with `stageuser_show`. Only structured upstream `NotFound` replies establish
absence. Permission failures, incomplete responses, outages and missing mirror
records never establish absence. An existing FreeIPA entry remains present even
when POSIX fields are missing; `eligible: false` must not be treated as deletion.
FreeIPA service credentials must have directory-wide visibility for these reads.
Directory permissions that deliberately hide entries cannot be detected from a
not-found reply. Reconciliation is a current observation, not a lock or a grant
to delete files; recheck it immediately before the administrative operation.
Pass an optional `AbortSignal` to bound an interactive scan or cancel it with
the request. The signal covers the upstream session and exact lookups, combined
with FreeIPA's existing 30-second timeout. Cancellation returns
`{ state: "unknown", reason: "provider_unavailable" }`, never absence.

Trusted application jobs can call
`accountIdentities.localLifecycle({ kind, identityId, name })` without creating
a request actor. This server-only read returns
`{ localLinuxEnabled, identity }`, where `identity` uses the same result above.
It supports only local identities and does not authorize an HTTP caller or
filesystem mutation. The job owns its administrative policy and must stop when
local Linux identities are disabled, the result is unknown, or identity IDs
conflict. It must not use account expiry or disabled login categories as reasons
to archive a directory.

### Administer Linux attributes

The platform service `linuxIdentities`, exported from
`@k2b/cloud/services`, enforces administrator access on every method,
including calls outside HTTP. It owns identity configuration, reads and
mutations; application-owned access grants do not confer this authority.

| Method and path below `/api/admin/core/linux-identities` | Purpose |
| --- | --- |
| `GET /` | Preview a page; optional UUID `after` cursor |
| `PUT /configuration` | Save `{ config, rangeReserved }`; enabled setup requires confirmation |
| `GET /users/:id` | Inspect one account and its identity state |
| `POST /users/:id` | Backfill missing attributes for one eligible local full account |
| `PATCH /users/:id` | Set local `homeDirectory` and `loginShell` |
| `POST /groups/:id` | Assign a GID to an existing local group |

The configuration is one validated value, `linux.identity_config`, in the
existing settings store. Use the dedicated administration API rather than
editing that JSON setting directly. Allocation and the current configuration
are checked inside each database transaction. No partial account or group
allocation is published when a check fails.

## Create and prepare POSIX groups

The Accounts group API supports both local and FreeIPA groups:

- `POST /api/accounts/groups` accepts `{ provider, name, description?, posix? }`.
  `posix` defaults to `false`. With `provider: "local"` and `posix: true`,
  group creation and GID assignment commit together.
- `PUT /api/accounts/groups/:id/posix` assigns a GID through the group's stored
  provider and returns `{ message, gidNumber }`. Repeating local assignment retains the GID.

Both operations require administrator access. Local POSIX writes also require
an enabled Linux identity configuration and a valid, available reserved range.
Failures leave no partial local group or allocation. Existing groups and GIDs
remain when assignment is disabled.

For supported administrator integrations, `linuxIdentities.createGroup(actor,
{ name, description? })` creates a local POSIX group and returns its `BaseGroup`
including `gidnumber`. It shares allocation and validation with
`linuxIdentities.provisionGroup(actor, id)`. The existing Core group endpoint
remains available for assigning a GID to an existing local group.

See [Assign Linux identities](/en/docs/operations/linux-identities) for setup,
name requirements and CLI examples.
