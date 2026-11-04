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

## All signed-in people

**Breaking:** `authenticated` object and app-list grants now match people
(`AccessSubject.type === "user"`), including guests. Agents and other service
accounts no longer inherit that tier. A person's session, personal API key,
OAuth credential, invocation or mandate still acts as that person. Public,
direct and group grants keep their behavior. Fixed application entry rules
such as `appAccess.signedIn()` are unchanged.

Before upgrading:

1. Run the read-only inventory below in `psql` against the installation's
   database. It covers every application that stores grants in `auth.access`,
   built-in and third-party. It lists active agent, standalone and
   resource-bound accounts, the link table and resource ID, and the
   authenticated permission they lose.
   A result is excluded only when an own, recursively inherited local-group,
   or supported public grant retains at least that permission (`read` < `write`
   < `admin`). A `none` row never excludes a result. Only standalone and agent
   accounts inherit local groups. Files storage includes grants on ancestor paths.
2. For every result, decide whether the machine should retain access. Add an
   explicit row or a local-group grant through the owning app before switching.
   Review AI quota rules separately: their grants are JSON configuration, not
   `auth.access` rows.
3. Upgrade Core and built-in applications together, then check the affected
   machine workflows. Third-party applications with an older `@k2b/cloud`
   keep the old behavior until they update and redeploy. Their grants appear
   in the same inventory, so decide for them before they update too.

For application authors: an app that checks its own resources with
`buildAccessPrincipalCondition`, `getEffectivePermission` or
`getEffectivePermissions` follows the new rule as soon as it uses this
`@k2b/cloud`; agents and service accounts then lose access that only an
`authenticated` grant gave them. Align everything the app shows about access
with it: a preview of who may do what, a count of an audience, or a copy of
the predicate must count people only for `authenticated`. The remedy for a
machine that needs access is an explicit grant for it, or for a local group it
belongs to; there is no setting that restores the old tier.

This is an inventory of stored grants, not a proof that a credential can
execute an operation: scopes, bindings, archived resources, app entry and
application-specific eligibility still apply. Review the listed resources in
their owning app. The accompanying integration guard checks the query against migrated test
schemas with absent, weaker, equal, stronger, denied, public and nested-group
alternatives, including resource-bound accounts.

The first SELECT generates two read-only SELECTs; `\gexec` executes them in
the same read-only transaction. The first lists the machines and their lost
permission. The tables come from the foreign keys that reference
`auth.access`, so optional and third-party applications are included when
installed. Resource IDs are JSON arrays containing the resource key, or
`[base_id, path]` for Files storage. For a table that no built-in application
owns, the resource key is the link row without its grant column and the usual
audit columns (`created_at`, `updated_at`, `added_at`, `added_by`,
`added_by_type`, `added_by_id`, `created_by`, `granted_at`, `granted_by`),
such as `[{"workspace": "office"}]`. If such a row holds more than the
resource, an own grant may not be matched, and the machine is listed although
it keeps access: review it in the owning app. The result does not depend on
the session's `search_path`.
`assistant.artifact_machine_rights` is grant metadata, not another object
link. The second result lists grants for all signed-in people that no table
links with a foreign key. An application keeps their IDs elsewhere; ask its
owner which resources they belong to. Mail's assigned-conversation
links are included for any stored audience grants; mailbox-wide alternatives
exclude them only at an equal or higher permission, and conversation assignments
still restrict actual reads.
Code is outside this migration.

```sql
BEGIN TRANSACTION READ ONLY;
WITH known(link_table, resource_expression, public_allowed) AS (
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
), references_to_access AS (
  -- Every table that links a grant with a foreign key to auth.access, built-in and app-owned.
  -- Names are schema-qualified whatever the search_path is.
  SELECT c.conrelid AS relid, format('%I.%I', n.nspname, t.relname) AS link_table, n.nspname AS link_schema,
    a.attname AS access_column
  FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE c.contype = 'f' AND c.confrelid = 'auth.access'::regclass AND cardinality(c.conkey) = 1
), links AS (
  SELECT k.link_table, k.resource_expression, k.public_allowed, 'access_id'::name AS access_column
  FROM known k WHERE to_regclass(k.link_table) IS NOT NULL
  UNION ALL
  -- App-owned tables: the resource is the link row without its grant column and the usual audit columns. Any other
  -- column, such as a date, stays part of the resource, so a grant on another resource never hides a loss.
  SELECT r.link_table, format('jsonb_build_array(to_jsonb(l) - %L::text[])', ARRAY[r.access_column::text,
      'created_at', 'updated_at', 'added_at', 'added_by', 'added_by_type', 'added_by_id', 'created_by', 'granted_at', 'granted_by']),
    true, r.access_column
  FROM references_to_access r
  WHERE r.link_table NOT IN (SELECT link_table FROM known)
    AND r.link_table <> 'assistant.artifact_machine_rights' AND r.link_schema <> 'code'
), object_queries AS (
  SELECT string_agg(format(
    'SELECT %L::text AS link_table, %s AS resource_id, %L::boolean AS public_allowed, a.* FROM %s l JOIN auth.access a ON a.id = l.%I',
    link_table, resource_expression, public_allowed, link_table, access_column),
    E'\nUNION ALL\n' ORDER BY link_table) AS body
  FROM links
), unlinked_query AS (
  -- Grants for all signed-in people that no table links with a foreign key: an app keeps their IDs elsewhere.
  SELECT format(
    'SELECT a.id AS access_id, a.permission, a.created_at FROM auth.access a WHERE a.authenticated_only AND a.permission IN (%L, %L, %L)%s ORDER BY a.created_at',
    'read', 'write', 'admin',
    COALESCE(string_agg(format(' AND NOT EXISTS (SELECT 1 FROM %s l WHERE l.%I = a.id)', link_table, access_column), ''), '')
  ) AS body
  FROM references_to_access
)
SELECT format($inventory$
WITH RECURSIVE machines AS (
  SELECT id, name, kind FROM auth.service_accounts
  WHERE status = 'active' AND kind IN ('agent', 'standalone', 'resource_bound')
), machine_groups AS (
  SELECT m.id AS service_account_id, sg.group_id
  FROM machines m JOIN auth.service_account_groups sg ON sg.service_account_id = m.id
  JOIN auth.groups g ON g.id = sg.group_id AND g.provider = 'local'
  WHERE m.kind IN ('standalone', 'agent')
  UNION
  SELECT mg.service_account_id, gg.parent_group_id
  FROM machine_groups mg JOIN auth.group_groups_v2 gg ON gg.child_group_id = mg.group_id
  JOIN auth.groups parent ON parent.id = gg.parent_group_id AND parent.provider = 'local'
), object_grants AS (
  %s
)
SELECT DISTINCT m.id AS service_account_id, m.name, m.kind, a.link_table, a.resource_id,
  a.permission AS lost_permission
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
      AND CASE other.permission WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 ELSE 0 END
        >= CASE a.permission WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 ELSE 0 END
      AND (other.service_account_id = m.id
        OR other.group_id IN (SELECT group_id FROM machine_groups WHERE service_account_id = m.id)
        OR (other.public_allowed AND NOT other.authenticated_only
          AND other.user_id IS NULL AND other.group_id IS NULL AND other.service_account_id IS NULL
          AND other.permission IN ('read', 'write', 'admin')))
  )
ORDER BY m.name, m.id, a.link_table, a.resource_id, a.permission
$inventory$, COALESCE(object_queries.body,
  'SELECT NULL::text AS link_table, NULL::jsonb AS resource_id, false AS public_allowed, a.* FROM auth.access a WHERE false')) AS inventory_query,
  unlinked_query.body AS unlinked_query
FROM object_queries, unlinked_query
\gexec
COMMIT;
```

## New machine credentials

New standalone and agent API keys created with `access: "full"` and omitted
`scopes` act as their account. Issuance stores `read`, `write`, and `admin`;
resource grants still limit every operation. Explicit scopes remain accepted
but are deprecated for new keys. Existing keys are unchanged, including empty
scope lists. Replace a limited key by issuing a new one and revoking the old
one. New OAuth clients created with `cld admin agents create` include `admin`;
existing clients are unchanged. No data migration is required. See
[Standalone service accounts and agents](/en/docs/identity/service-accounts#use-an-agent-from-the-cli).
