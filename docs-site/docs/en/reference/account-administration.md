---
title: Account administration API
navTitle: Account administration
section: Reference
order: 1276
description: Display account categories, manage Linux identities, and pair or remove a person's Cloud app devices through supported APIs.
tags: [accounts, api, linux]
updated: 2026-10-23
---

# Account administration API

For application authors integrating account presentation or administrator-only
Linux identity and device operations. For configuration in Administration, start with
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
`{ id, provider, name, gidNumber, personal }`, including logical groups with a
null GID. `personal` is `true` for a user's personal Linux group (their stored
primary group); applications should not offer it as a shared group area or
recipient.
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
| `PUT /configuration` | Save `{ config, rangeReserved, replaceUnreadable? }`; enabled setup requires confirmation |
| `GET /users/:id` | Inspect one account and its identity state |
| `POST /users/:id` | Backfill missing attributes for one eligible local full account |
| `PATCH /users/:id` | Set local `homeDirectory` and `loginShell` |
| `POST /groups/:id` | Assign a GID to an existing local group |

The configuration is one validated value, `linux.identity_config`, in the
existing settings store. Administration reads add `config.unreadable`; omit that
read-only marker from the configuration in a PUT. The service's
`configure(actor, config, { replaceUnreadable: true })` and the API's
`replaceUnreadable: true` explicitly replace an unreadable configuration.
Without this intent the write fails with HTTP 409 `setting_unreadable`.
Use the dedicated administration API rather than
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

## Remove devices from the Cloud app

> **Preview:** the Cloud app is not released yet. This contract may still
> change until it is, without counting as a breaking change.

Administrators list and remove another account's devices in the Cloud app
through the Accounts API. Both routes require the `admin` role. An
administrator's own app session never carries that role, so the Cloud app
cannot call them. A web session in the device's browser is independent of the
app and keeps its role until it ends; removing the device does not end it.

| Method and path below `/api/accounts/users` | Result |
| --- | --- |
| `GET /:id/app-devices` | `{ devices }` with `id`, `name`, `platform` (`ios`, `android` or `other`), `createdAt`, `lastUsedAt` and `current` (always `false` here) |
| `DELETE /:id/app-devices/:deviceId` | `{ revoked }`: `true` for the call that removed the device, `false` when it was already removed |

An unknown account or a device of another account answers `404`. Cloud purges a
removed device 30 days after removal at the earliest; from then on, repeating
the removal also answers `404`. Removal ends
the device's app sessions in the same transaction, so every application's
validator rejects them at once; the app then shows that the device was signed
out. Cloud audits the removal as `auth.pwa.device.revoke` with the
administrator as actor and no notification is sent.

`cld accounts users app-devices list` and `remove` call these routes and
print the response with `--json`.

Both routes call `pwaDevices.listUserDevices(admin, userId)` and
`pwaDevices.revokeUserDevice(admin, userId, deviceId)` from
`@k2b/cloud/services`, which refuse callers whose `admin` flag is `false`.
Pass the request actor's current roles; see
[App sessions](/en/docs/identity/authentication#app-sessions-preview) for the
session contract.

## Pair the Cloud app for another account

Core owns administrative Cloud app pairing below `/api/auth/pwa/v1`. The
Accounts user detail calls it from its **Cloud app** section. Cloud Login uses
its existing, separate sign-in device APIs.

| Method and path below `/api/auth/pwa/v1` | Result |
| --- | --- |
| `POST /users/:userId/pairings` | `201` with `{ id, secret, claimUntil, expiresAt }`; the secret is returned once |
| `GET /pairings/:id` | State, validity, device name and platform, remaining code attempts; never a code or decision token |
| `POST /pairings/:id/confirm` | `{ code }`; `204` moves an administrative pairing to `awaiting_device` |
| `POST /pairings/:id/cancel` | `204`; cancels an unfinished pairing |

Only the initiating web session may read, confirm or cancel a pairing. Starting
requires a current administrator with a web sign-in from the last ten minutes,
an active target account and a registered `pwa` application. API keys,
authorization headers and app sessions are refused. The service
`pwaDevices.startUserPairing(actor, userId)` checks administrator authority and
fresh web-session evidence too. The target's account limits remain
`PWA_LIMITS.pendingPerAccount` and `PWA_LIMITS.devicesPerAccount`.

On the device, `/pwa/_auth/pairings/claim` consumes the link and sets the
HttpOnly, same-site completion cookie. `/pairings/complete` under the same
prefix returns `202` with `state: "confirmation_required"`, target `account`,
`administrator`, `confirmationToken` and `expiresAt` after code confirmation.
Polling alone issues no credentials. Render the account and administrator,
then send the person's explicit choice to `POST /pwa/_auth/pairings/decision`
as `{ confirmationToken, decision: "confirm" | "reject" }`.

The server binds this token's hash to the claimed pairing and checks it together
with the completion cookie. It issues the token only in `awaiting_device`;
a new confirmation response replaces the preceding token. The same decision
can be repeated after a lost response. A conflicting decision returns `409`.
Acceptance moves to `confirmed`, allowing `/pairings/complete` to enroll the
device for the target account and issue its credentials. Rejection moves to
`rejected`; completion returns `{ state: "rejected" }` with no credentials.

Administrative states are `pending → claimed → awaiting_device → confirmed →
completed`, or `awaiting_device → rejected`. Cancellation, three incorrect
codes, expiry, account eligibility changes and invalidation of the initiating
web session stop the flow. Self-pairing continues to use `pending → claimed →
confirmed → completed`.

Audit actions are `auth.pwa.pairing.start`, `auth.pwa.pairing.confirm`,
`auth.pwa.pairing.device_confirm` or `auth.pwa.pairing.reject`, and
`auth.pwa.device.enroll`. All carry `targetUserId` and `administratorUserId` in
metadata. The administrator is the actor for start, code confirmation and
enrollment; the target is the actor for the decision made with the device's
completion credential. The paired-device notification includes the
administrator's display name, retained for notification retries.

See [Pair the Cloud app for someone](/en/docs/accounts/devices#pair-the-cloud-app-for-someone)
for the administrator and device steps.
