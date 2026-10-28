---
title: Upgrade application access declarations
navTitle: App access upgrade
section: Operations
order: 1190
description: Roll out declarative application access while preserving public routes and existing callers.
tags: [operations, upgrades, identity]
updated: 2026-10-28
---

# Upgrade application access declarations

Update Core before applications that declare configurable access. Core creates
the shared access-list and first-configuration tables. If the shared store is
unavailable, configurable access fails closed, including its transition rule.

Applications without an `access` declaration keep their current behavior in
this release and log a startup warning. Requiring the declaration for all
applications is a separate major-version change.

For each application update:

1. Confirm the chosen fixed rule preserves its supported callers, including
   standalone and delegated service accounts. Navigation roles alone are not
   evidence for the entry rule.
2. Check public share links, webhooks, OAuth callbacks, legal pages, manifests,
   and any endpoint with specialized authentication. Their declared exemptions
   retain their own route authentication.
3. Verify the application disappears from discovery without access, a direct
   link shows a denial, and a permitted API credential still works.
4. Test revocation with an open page and live connection. The next request must
   fail and the connection must close within one minute, even if an event is
   lost.

An installation administrator may repair configurable access without gaining
use of the application. Keep that distinction when investigating an app that
is absent from the administrator's launcher.

## Configure and repair access lists

All built-in applications retain fixed access rules in the first rollout.
**Administration → Apps** shows each application's rule; **Repair access** is
available only for applications that declare `appAccess.grants()`.
Operators cannot turn a fixed rule into a list from this screen.

For an application moving to a list, preserve its exact fixed predecessor in
`appAccess.grants({ until: previousRule })`. Before the first successful edit,
that rule still controls use. Use **Repair access** to assign the first
manager. First save ends the transition; check the intended audience before
saving. A signed-in predecessor is preserved as a signed-in Use entry, which
a manager can later remove. A role-based or no-guests predecessor does not
create that audience grant.

Repair is explicit administration authority, not an implicit Manage access or
Use grant. It bypasses the application's optional `canManage` restriction so
an administrator can restore a manager. It does not bypass credential caps;
mobile app sessions cannot repair access. Ordinary app management still
requires its own manager grant and any application restriction.

The shared `/_cloud/app-access/:appId` route redirects ordinary management to
the owning application's framework route with HTTP 307. The application must
be running for this path and its `canManage` check. Explicit repair uses Core
directly with `?repair=1` and the shared store. If a save cannot be confirmed,
reload the list before retrying; the editor blocks further edits until it can
read the current state.

Each edit commits its audit record, configuration marker, and change
notification together with the grant. Repair records use
`via: "platform-admin"` with the `app.access.granted`, `app.access.updated`, or
`app.access.revoked` action. A failed audit or notification write rolls back
the edit. HTTP 409 `LAST_MANAGER` means the edit would leave no effective
manager; assign another manager before removing or downgrading the current
one. Empty groups and expired or disabled principals do not keep a list
manageable. Recheck management after account or group changes, which can
remove the last effective manager outside a list edit.

The gateway continues to route requests; the application process enforces the
entry rule. See [App access](/en/docs/identity/app-access) for declarations and
transition behavior.

## Built-in application rules

Gateway (`gateway-ops`), Hosts (`ipa-hosts`), OAuth, and Proxy Auth declare administrator-only use.
The other built-in applications declare signed-in use and keep their existing
route and resource permissions. No built-in application switches to an access
list in this rollout.

Declared public routes retain their existing authentication, including share
tokens, Cloud Login, phone device keys, and Pulse ingest credentials. An
exception for one of these routes does not grant app discovery or access to
other routes.

API Docs and Tools no longer appear in navigation for signed-out visitors.
Their public direct URLs remain available. Signed-in discovery still depends
on the caller's app access and the application's navigation placement.

## Roll out resource-derived app access

Upgrade Core and discovery consumers to a Cloud version supporting
`appAccess.resources()` before starting an application with that declaration.
Older registry readers reject an unknown rule. No database migration, copied
app grants, or synchronization job is needed for resource-derived access.
Built-in applications keep their declared rules until deliberately changed.

The application must be reachable from Core at its registered `baseUrl`.
Other application processes require `CLOUD_CORE_INTERNAL_ORIGIN` to resolve
resource-derived discovery; the gateway blocks these internal routes. Core alone signs the target-bound existence
probe; keep private identity keys in Core. Probe tokens cannot authorize app
operations or be exchanged for further probes. The framework mounts these checks
before app entry, and they return only an allow/deny status. The authenticated
Core relay uses the existing configurable Cloud request rate limit. Overload
and transport errors deny discovery until a later request succeeds.

If an app disappears unexpectedly, verify its running version, Core's route
to it, and its adapter's existence query. Query failures and the ten-second
probe deadline deny access. Do not repair a resource-derived rule by creating
an app-access list: restore the resource permission or fix the query.
The adapter must preserve resource eligibility, group semantics and bound-key
limits and cancel its query when the probe aborts.

Revocation takes effect on the next request; there is no cache across
requests. Open live connections retain the one-minute revalidation bound.
Verify grant, last-right removal, group removal, guest and service-account
entry, and matching search and CLI visibility before adopting the rule.
