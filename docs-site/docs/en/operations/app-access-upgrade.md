---
title: Upgrade application access declarations
navTitle: App access upgrade
section: Operations
order: 1190
description: Roll out application access rules and check affected callers before upgrading.
tags: [operations, upgrades, identity]
updated: 2026-11-03
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
Cloud app sessions cannot repair access. Ordinary app management still
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
Spaces, Grids, Contacts, Mail, Pulse, and Venue declare `appAccess.noGuests()`;
see the [guest upgrade check](#check-guest-access-before-upgrading). Other built-in
applications retain their declared rules and existing route and resource
permissions. No built-in application switches to an access list in this rollout.

Declared public routes retain their existing authentication, including share
tokens, Cloud Login, phone device keys, and Pulse ingest credentials. An
exception for one of these routes does not grant app discovery or access to
other routes.

API Docs and Tools no longer appear in navigation for signed-out visitors.
Their public direct URLs remain available. Signed-in discovery still depends
on the caller's app access and the application's navigation placement.

## Check guest access before upgrading

Spaces, Grids, Contacts, Mail, Pulse, and Venue now reject guest accounts on
API and CLI requests as well as pages. A direct or group-inherited object
grant no longer admits a guest to these apps. Personal keys, OAuth tokens,
and other credentials delegated by a guest have the same restriction.
Rejected API requests return HTTP 403 with `code: "app_access_denied"`.
The apps also disappear from guest discovery, including Assistant and Chat
capabilities, widgets, search providers, and CLI plugins.

Before deploying this change, run this read-only query against the installation's
Postgres database. It lists guest accounts with direct or group-inherited
`read`, `write`, or `admin` grants, including nested groups, with an object count
per app. Counts deduplicate multiple grants to the same object. Grids counts
bases and custom apps separately; Mail includes both mailbox-wide and
assigned-conversation grants, counting each mailbox once.

```sql
WITH RECURSIVE guest_groups(user_id, group_id) AS (
  SELECT ug.user_id, ug.group_id
  FROM auth.user_groups_v2 ug
  JOIN auth.users u ON u.id = ug.user_id
  WHERE u.profile = 'guest'
  UNION
  SELECT gg.user_id, nested.parent_group_id
  FROM guest_groups gg
  JOIN auth.group_groups_v2 nested ON nested.child_group_id = gg.group_id
), object_grants(app, object_type, object_id, access_id) AS (
  SELECT 'spaces', 'space', space_id, access_id FROM spaces.space_access
  UNION ALL
  SELECT 'grids', 'base', base_id, access_id FROM grids.base_access
  UNION ALL
  SELECT 'grids', 'custom_app', custom_app_id, access_id FROM grids.custom_app_access
  UNION ALL
  SELECT 'contacts', 'book', book_id, access_id FROM contacts.book_access
  UNION ALL
  SELECT 'mail', 'mailbox', mailbox_id, access_id FROM mail.mailbox_access
  UNION ALL
  SELECT 'mail', 'mailbox', mailbox_id, access_id FROM mail.mailbox_assigned_access
  UNION ALL
  SELECT 'pulse', 'base', base_id, access_id FROM pulse.base_access
  UNION ALL
  SELECT 'venue', 'venue', venue_id, access_id FROM venue.venue_access
)
SELECT u.id AS guest_id, u.uid, u.mail, o.app,
       count(DISTINCT (o.object_type, o.object_id)) AS object_count
FROM auth.users u
JOIN auth.access a ON a.user_id = u.id OR EXISTS (
  SELECT 1 FROM guest_groups gg
  WHERE gg.user_id = u.id AND gg.group_id = a.group_id
)
JOIN object_grants o ON o.access_id = a.id
WHERE u.profile = 'guest' AND a.permission IN ('read', 'write', 'admin')
GROUP BY u.id, u.uid, u.mail, o.app
ORDER BY u.uid, o.app;
```

Run it where all six apps' schemas are installed. This is an inventory of
stored direct and group grants, including expired accounts and grants on
archived objects; it does not prove that every listed object is currently usable.
Public and signed-in audience grants are outside this report. An empty result
means no direct or group grants were found, not that guests cannot currently
reach objects through those audiences.

For each affected person, give them a full account before upgrading if they
should retain access, or accept that their guest account will lose it. Existing
object grants stay stored; no data migration or grant copying is needed.

Declared public routes retain their own authentication: Grids forms, document
shares and published apps; Mail attachment links; Pulse ingest keys and
published dashboards; and Venue public status, feedback, and calendar links.
OpenAPI routes remain public. Resource-bound object keys, standalone service
accounts, and agent accounts remain eligible, with the same scopes, bindings,
and object permissions. A key's creator being a guest does not turn an
independent resource-bound key into a guest-delegated credential.

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
