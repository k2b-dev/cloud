---
title: Upgrade application access declarations
navTitle: App access upgrade
section: Operations
order: 1190
description: Roll out declarative application access while preserving public routes and existing callers.
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

## All signed-in people

**Breaking:** `authenticated` object and app-list grants now match people
(`AccessSubject.type === "user"`), including guests. Agents and other service
accounts no longer inherit that tier. A person's session, personal API key,
OAuth credential, invocation or mandate still acts as that person. Public,
direct and group grants keep their behavior. Fixed application entry rules
such as `appAccess.signedIn()` are unchanged.

Before upgrading:

1. Run the read-only inventory below in `psql` against the installation's
   database. It lists each active agent or standalone account and the link
   table and resource ID with an authenticated grant but no own or recursively
   inherited local-group row. Positive public access excludes an object where
   that application supports it. Any own or group row, including a deny,
   excludes it. Files storage includes grants on ancestor paths.
2. For every result, decide whether the machine should retain access. Add an
   explicit row or a local-group grant through the owning app before switching.
   Review AI quota rules separately: their grants are JSON configuration, not
   `auth.access` rows.
3. Upgrade Core and built-in applications together, then check the affected
   machine workflows. Third-party applications with an older `@k2b/cloud`
   keep the old behavior until they update and redeploy. Update any app-owned
   copies of the predicate to match user access subjects only.

This is an inventory of stored grants, not a proof that a credential can
execute an operation: scopes, bindings, archived resources, app entry and
application-specific eligibility still apply. Review the listed resources in
their owning app. The accompanying integration guard checks the query against migrated test
schemas with absent, direct, denied, public and nested-group alternatives.

The first SELECT generates a second read-only SELECT; `\gexec` executes it in
the same read-only transaction. Optional app tables are included only when
installed. Resource IDs are JSON arrays containing the resource key, or
`[base_id, path]` for Files storage. The mapping comes from application
migrations referencing `auth.access`. `assistant.artifact_machine_rights`
is grant metadata, not another object link. Mail's assigned-conversation
links are included for any stored audience grants; mailbox-wide alternatives
exclude them, and conversation assignments still restrict actual reads.
Code is outside this migration.

```sql
BEGIN TRANSACTION READ ONLY;
WITH links(link_table, resource_expression, public_allowed) AS (
  VALUES
    ('auth.app_access', 'jsonb_build_array(l.app_id)', false),
    ('auth.rail_shortcut_access', 'jsonb_build_array(l.shortcut_id)', true),
    ('ai.project_access', 'jsonb_build_array(l.project_id)', true),
    ('ai.skill_access', 'jsonb_build_array(l.skill_id)', true),
    ('ai.model_access', 'jsonb_build_array(l.model_id)', true),
    ('assistant.artifact_access', 'jsonb_build_array(l.artifact_id)', true),
    ('spaces.space_access', 'jsonb_build_array(l.space_id)', true),
    ('grids.base_access', 'jsonb_build_array(l.base_id)', false),
    ('grids.custom_app_access', 'jsonb_build_array(l.custom_app_id)', true),
    ('pulse.base_access', 'jsonb_build_array(l.base_id)', true),
    ('notebooks.notebook_access', 'jsonb_build_array(l.notebook_id)', true),
    ('contacts.book_access', 'jsonb_build_array(l.book_id)', true),
    ('chat.conversation_access', 'jsonb_build_array(l.conversation_id)', true),
    ('venue.venue_access', 'jsonb_build_array(l.venue_id)', true),
    ('filesv2.storage_access', 'jsonb_build_array(l.base_id, l.path)', true),
    ('filesv2.template_access', 'jsonb_build_array(l.template_id)', true),
    ('mail.mailbox_access', 'jsonb_build_array(l.mailbox_id)', true),
    ('mail.mailbox_assigned_access', 'jsonb_build_array(l.mailbox_id)', true)
), object_queries AS (
  SELECT string_agg(format(
    'SELECT %L::text AS link_table, %s AS resource_id, %L::boolean AS public_allowed, a.* FROM %s l JOIN auth.access a ON a.id = l.access_id',
    link_table, resource_expression, public_allowed, to_regclass(link_table)),
    E'\nUNION ALL\n' ORDER BY link_table) AS body
  FROM links WHERE to_regclass(link_table) IS NOT NULL
)
SELECT format($inventory$
WITH RECURSIVE machines AS (
  SELECT id, name, kind FROM auth.service_accounts
  WHERE status = 'active' AND kind IN ('agent', 'standalone')
), machine_groups AS (
  SELECT m.id AS service_account_id, sg.group_id
  FROM machines m JOIN auth.service_account_groups sg ON sg.service_account_id = m.id
  JOIN auth.groups g ON g.id = sg.group_id AND g.provider = 'local'
  UNION
  SELECT mg.service_account_id, gg.parent_group_id
  FROM machine_groups mg JOIN auth.group_groups_v2 gg ON gg.child_group_id = mg.group_id
  JOIN auth.groups parent ON parent.id = gg.parent_group_id AND parent.provider = 'local'
), object_grants AS (
  %s
)
SELECT DISTINCT m.id AS service_account_id, m.name, m.kind, a.link_table, a.resource_id
FROM machines m CROSS JOIN object_grants a
WHERE a.authenticated_only AND a.permission IN ('read', 'write', 'admin')
  AND NOT EXISTS (
    SELECT 1 FROM object_grants other
    WHERE (other.link_table = a.link_table OR (
      a.link_table = 'mail.mailbox_assigned_access' AND other.link_table = 'mail.mailbox_access'))
      AND (other.resource_id = a.resource_id OR (
        a.link_table = 'filesv2.storage_access'
        AND other.resource_id->>0 = a.resource_id->>0
        AND (other.resource_id->>1 = '' OR
          left(a.resource_id->>1, length(other.resource_id->>1) + 1) = (other.resource_id->>1) || '/')
      ))
      AND (other.service_account_id = m.id
        OR other.group_id IN (SELECT group_id FROM machine_groups WHERE service_account_id = m.id)
        OR (other.public_allowed AND NOT other.authenticated_only
          AND other.user_id IS NULL AND other.group_id IS NULL AND other.service_account_id IS NULL
          AND other.permission IN ('read', 'write', 'admin')))
  )
ORDER BY m.name, m.id, a.link_table, a.resource_id
$inventory$, COALESCE(body,
  'SELECT NULL::text AS link_table, NULL::jsonb AS resource_id, false AS public_allowed, a.* FROM auth.access a WHERE false')) AS inventory_query
FROM object_queries
\gexec
COMMIT;
```
