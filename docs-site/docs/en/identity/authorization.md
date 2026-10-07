---
title: Resource authorization
navTitle: Resource authorization
section: Identity and access
order: 320
description: Resolve resource grants in application services for users, groups, service accounts, and public callers.
tags: [identity, authorization, permissions, services]
updated: 2026-10-06
---

# Resource authorization

The service that reads or changes a resource checks its permission.

Every API route, SSR page, background action, and CLI command should reach the
same permission-aware service.

## Permission levels

Cloud permissions are ordered:

```text
none < read < write < admin
```

Use `hasPermission()` instead of comparing strings:

```ts
import { hasPermission } from "@k2b/cloud/server";

if (!hasPermission(permission, "write")) {
  return fail(err.forbidden("Access denied"));
}
```

Applications decide what each level means for their resources. `admin` also
makes an entry a manager; see [Keep at least one manager](#keep-at-least-one-manager).

## Principals

An access entry grants one permission to one principal:

```ts
type Principal =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string }
  | { type: "service_account"; serviceAccountId: string }
  | { type: "authenticated" }
  | { type: "public" };
```

| Principal | Matches |
| --- | --- |
| User | One user |
| Group | Direct and nested members |
| Service account | One machine identity: resource-bound, standalone, or agent |
| Authenticated | Any authenticated user or service account |
| Public | Every caller, including anonymous requests |

### Discover principals safely

Cloud's entity search is caller-scoped before it applies text, kind, provider,
or relation filters:

- full user accounts can search the account directory;
- guest accounts can find only themselves and their direct or recursively
  inherited groups;
- anonymous callers and userless service accounts cannot search identities.

A group result contains the group's identity, not its members. A guest who
shares a group with another user cannot discover that user through entity
search. Applications may narrow results to accepted principal kinds, but
client-provided filters never widen the caller's server-side visibility.
Relationship filters are directory operations and remain limited to full user
accounts.

## Link access entries to the resource

Cloud owns `auth.access`. The application owns a junction table:

```sql
CREATE TABLE IF NOT EXISTS inventory.item_access (
  item_id   UUID NOT NULL
    REFERENCES inventory.items(id) ON DELETE CASCADE,
  access_id UUID NOT NULL
    REFERENCES auth.access(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, access_id)
);
```

Implement a `ResourceAccessAdapter` around that table.

```ts
const itemAccess: ResourceAccessAdapter = {
  list: (itemId) => repository.listAccess(itemId),
  add: (itemId, accessId) => repository.linkAccess(itemId, accessId),
  remove: (itemId, accessId) =>
    repository.unlinkAccess(itemId, accessId),
  count: (itemId) => repository.countAccess(itemId),
};
```

The adapter returns normalized `AccessEntry` values and keeps the platform
grant separate from the application junction table.

## Resolve one resource

Pass the request's access subject directly to the resolver:

```ts
import {
  type AccessSubject,
  type ResourceAccessAdapter,
  getEffectivePermission,
} from "@k2b/cloud/server";

const resolveItemPermission = async (
  itemId: string,
  subject: AccessSubject | null,
  access: Pick<ResourceAccessAdapter, "list">,
) => {
  const entries = await access.list(itemId);

  return getEffectivePermission({
    accessIds: entries.map((entry) => entry.id),
    subject,
  });
};
```

The resolver returns the highest matching permission.

For a user subject it includes:

- the direct user grant;
- direct and recursively nested group grants;
- authenticated grants;
- public grants.

For a resource-bound or standalone service account it includes:

- the direct service-account grant;
- authenticated grants;
- public grants.

A standalone or agent account has no resource binding, so it is not capped to
one resource; its grants and its credential scopes limit it.

Do not pass `User.memberofGroupIds`. The shared resolver reads authoritative
membership itself.

To decide one resource for many subjects, for example the readers of a
[live channel](/en/docs/automation/live-updates), use
`getEffectivePermissions({ accessIds, subjects })`. It returns one permission
per subject, in the same order, with one query instead of one per subject, by
the same rules.

## Check inside the service

Pass both request identity values into the service:

```ts
const result = await inventory.items.update({
  id: c.req.param("id"),
  input: c.req.valid("json"),
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
});

return respond(c, result);
```

Use `accessSubject` to resolve grants. Use `actor` for audit context and
credential limits.

The service should check `write` before changing the item.

## Limit resource-bound credentials

A resource-bound service account must pass three checks:

1. its `appId`, `resourceType`, and `resourceId` match the requested resource;
2. its service-account principal has a matching access grant;
3. its credential scope allows the operation.

The effective permission is the lower of the resource grant and the scope.

```text
resource grant: admin
credential scope: read
effective: read
```

Scopes never grant access.

Use one service helper for the complete check:

```ts
import {
  type AccessSubject,
  type PermissionLevel,
  type RequestActor,
  type ResourceAccessAdapter,
  err,
  fail,
  getEffectivePermission,
  hasPermission,
  ok,
  type Result,
} from "@k2b/cloud/server";

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const permissionFromScopes = (
  scopes: readonly string[],
): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

const lowerPermission = (
  permission: PermissionLevel,
  cap: PermissionLevel,
): PermissionLevel =>
  PERMISSION_RANK[permission] <= PERMISSION_RANK[cap]
    ? permission
    : cap;

export const requireItemPermission = async (input: {
  itemId: string;
  required: PermissionLevel;
  actor: RequestActor;
  accessSubject: AccessSubject;
  access: Pick<ResourceAccessAdapter, "list">;
}): Promise<Result<PermissionLevel>> => {
  // Every service account without a delegated user is capped by its scopes:
  // resource-bound, standalone, and agent accounts alike.
  const scopedCredential =
    input.actor.kind === "service_account" &&
    input.actor.delegatedUser === null
      ? input.actor
      : null;
  const account = scopedCredential?.serviceAccount;

  if (
    account?.kind === "resource_bound" &&
    (account.appId !== "inventory" ||
      account.resourceType !== "item" ||
      account.resourceId !== input.itemId)
  ) {
    return fail(err.forbidden("Access denied"));
  }

  const entries = await input.access.list(input.itemId);
  const granted = await getEffectivePermission({
    accessIds: entries.map((entry) => entry.id),
    subject: input.accessSubject,
  });
  const effective = scopedCredential
    ? lowerPermission(
        granted,
        permissionFromScopes(scopedCredential.scopes),
      )
    : granted;

  return hasPermission(effective, input.required)
    ? ok(effective)
    : fail(err.forbidden("Access denied"));
};
```

This order is deliberate:

1. reject a resource-bound credential bound to another application or resource;
2. resolve the service-account grant through `accessSubject`;
3. lower that grant to the credential scope;
4. compare the effective permission with the operation.

The same helper accepts user and user-delegated actors. They use their user
grants and are not scope-capped. A standalone or agent account skips the
binding check, because it has none, but is still lowered to its scopes.

Collection and search endpoints must restrict a resource-bound credential's
query to its bound resource or reject it. A standalone or agent account lists
exactly what its grants cover, like a user; never reject it only because it is
not user-backed. Authentication alone must not expose every item.

See [Resource API keys](/en/docs/identity/resource-api-keys) for service-account
and credential creation.

## Repeat the check for SSR

An SSR page often calls the service directly. Its JSON route did not run.

The page must therefore:

1. use a [route policy](/en/docs/identity/route-policies);
2. call the same permission-aware service;
3. render only the data returned by that service.

Do not treat a successful page login as resource authorization.

## Filter lists in SQL

Do not load every resource and check it in a loop.

Use `buildAccessPrincipalCondition()` inside the list query. Either bind a
resource credential to one exact resource or reject it before a collection
query. This example rejects it:

```ts
if (actor.kind === "service_account" && actor.delegatedUser === null) {
  return fail(err.forbidden("Resource credentials cannot list items"));
}

const principal = buildAccessPrincipalCondition({
  subject: accessSubject,
  columns: {
    userId: sql`a.user_id`,
    groupId: sql`a.group_id`,
    serviceAccountId: sql`a.service_account_id`,
    authenticatedOnly: sql`a.authenticated_only`,
  },
});

const items = await sql`
  SELECT DISTINCT i.*
  FROM inventory.items i
  JOIN inventory.item_access ia ON ia.item_id = i.id
  JOIN auth.access a ON a.id = ia.access_id
  WHERE ${principal}
    AND a.permission IN ('read', 'write', 'admin')
  ORDER BY i.name, i.id
`;
```

The predicate uses the same direct, nested-group, authenticated, and public
rules as `getEffectivePermission()`.

The permission filter enforces `read` for this endpoint. A different operation
must use its own required level.

If a collection endpoint accepts a resource-bound credential instead, add an
exact `appId`, resource type, and resource ID check before SQL. Restrict the SQL
to that ID and cap the result by the credential scope.

## Create and change grants

Use the shared grant services:

```ts
const created = await createAccess({
  principal: { type: "group", groupId },
  permission: "write",
});

if (created.ok) {
  await itemAccess.add(itemId, created.data.id);
}
```

| Helper | Result |
| --- | --- |
| `createAccess()` | Validate and create a platform access entry |
| `updateAccess()` | Change its permission |
| `deleteAccess()` | Delete the entry |

If linking a new entry fails, remove it again. Protect grant mutations with
`admin` permission on the resource.

### Keep at least one manager

A resource keeps at least one manager: an `admin` entry for a user, a group,
all signed-in users, or a standalone or agent service account. A group counts
regardless of its current members. Public entries never count, and neither do
resource-bound or user-delegated service accounts: they disappear with their
key or their user without passing the resource's rules.

Check every change of an existing grant with `ensureManagerRemains()` from
`@k2b/cloud/server`, on administration routes too. Lock the resource row, then
authorize the actor and read the entries in the same transaction, with
`serviceAccountKind` for service accounts. `getEffectivePermission()` takes the
transaction as its second argument:

```ts
const result = await sql.begin(async (tx): Promise<Result<void>> => {
  await tx`SELECT id FROM items.items WHERE id = ${itemId}::uuid FOR UPDATE`;
  const before = await listItemAccess(itemId, tx);
  const accessIds = before.map((entry) => entry.id);
  const actorPermission = await getEffectivePermission({ accessIds, subject: c.get("accessSubject") }, tx);
  if (!hasPermission(actorPermission, "admin")) return fail(err.forbidden("Access denied"));
  const after = before.map((entry) => (entry.id === accessId ? { ...entry, permission } : entry));
  const guarded = ensureManagerRemains({ before, after, locale: getLocale(c) });
  if (!guarded.ok) return guarded;
  await tx`UPDATE auth.access SET permission = ${permission}::auth.permission_level WHERE id = ${accessId}::uuid`;
  return ok();
});
```

The lock makes concurrent changes see each other: two managers who lower each
other at the same moment cannot both succeed, and a manager who lost access
while their change waited is refused. Only a change from at least
one manager to none fails, with status `409`, code `LAST_MANAGER`, and a
localized message. The message calls the level “Manage”, as the permission
editor does; if your editor names `admin` differently, pass your localized name
as `level`. A resource that has no manager already stays repairable,
because granting a manager is always allowed. To hand a resource over, or to
recover it as an administrator, grant the new manager first and then change
the old one.

If your application's precedence lets one entry shadow another, such as a
`none` that overrides `admin` in the same tier, drop the shadowed entries from
both lists before the check, and check a new `none` grant as well. Changes
outside the grants are not checked: deleting an account, a group, or a service
account, and changing group membership. Some built-in applications still use
their own older check; see
[Resources keep at least one manager](/en/docs/reference/deprecations-and-migrations#resources-keep-at-least-one-manager).

Call `resolveDisplayNames()` when adapter entries do not include names. It also
accepts `{principal}` records for a proposed grant, preserves supplied fields,
and adds `displayName`, optional `avatarHash`, and, for service-account
principals, `serviceAccountKind`. A person's `displayName` is their display
name, or their login name when they have none, so every permission editor names
people the same way. Authorize the resource operation
before resolving names. A confirmation should show both name and principal ID;
names are presentation, never identity or authorization.

`listUsersWithAccess()` expands direct user and nested group grants for bounded
pickers. It supports search, included and excluded user IDs, a minimum
permission, and a limit from `1` to `500`. It does not expand `public` or
`authenticated` into every account.

Keep grant editing and credential creation separate. The permission editor
must not display raw keys or own secret lifecycle.


For assignment forms that need identity selection without permission levels,
use `PrincipalPicker` from `@k2b/cloud/access/ui`. Its `onSelect` callback returns
a `Principal` and display metadata: `displayName` and, for service accounts,
`serviceAccountKind`. The consumer owns persistence and authorization.
Pass `existing` to exclude already selected principals. Users and groups are
searched through Accounts after two characters; personal Linux groups are left
out, so people are granted directly. All signed-in users are
available by default; `allowAuthenticated={false}` removes that option.
Public and service-account selection require `allowPublic` and
`allowServiceAccounts` respectively. This picker grants no access itself.

### Restrict editor levels by principal

`PermissionEditor` from `@k2b/cloud/access/ui` accepts either an `allowedLevels`
array or a function `(principal: Principal) => AllowedLevel[]`. The function is
used for both new grants and existing rows. For example, return `["read"]` for
public recipients and `["read", "admin"]` for users and groups. A single allowed
level renders as a fixed badge. Enforce the same restriction in the resource's
service; the editor does not authorize requests.

### Show the last manager

When exactly one entry is a manager, as defined in
[Keep at least one manager](#keep-at-least-one-manager), the editor keeps its
row from changing: the lower levels are disabled with a short explanation, and
the remove button is disabled with the same explanation as its hint and its
accessible description. The row
keeps its size, so granting a second manager unlocks it without moving
anything. The editor counts only the entries it shows; the service stays the
authority, and its `LAST_MANAGER` message reaches the person as an error.

Pass the editor every entry that can count as a manager. Agents and standalone
service accounts manage a resource like people do, so they keep their row and
their kind label. Hide only entries that never count: an editor next to
[`ResourceApiKeys`](/en/docs/identity/resource-api-keys#add-the-api-key-ui)
hides the resource-bound entries that the key list manages. An editor that hid
an agent with “Manage” would lock the person who manages next to it, although
the service accepts their change.

Rows for all signed-in users and for the public always show the editor's
localized label, whatever `displayName` the entry carries.

### Show service-account kinds

Editor rows and picker results show one icon and label per service-account
kind:

| Kind | Icon | Label |
| --- | --- | --- |
| `agent` | `ti-robot` | Agent |
| `standalone` | `ti-key` | Service account |
| `resource_bound` | `ti-box` | Resource-bound service account |
| `user_delegated` | `ti-user-key` | User-bound service account |

Picker and entity-search results for resource-bound accounts show the app,
resource type, and resource ID instead of the label, because several such
accounts often share a name.

A row reads the kind from the entry's `serviceAccountKind`. Return entries
from `resolveDisplayNames()`, or select `auth.service_accounts.kind` next to
the name, both from the list and from `grantAccess`. A form that keeps new
grants as a draft builds the entry from the `display` argument of
`grantAccess`, which carries the kind the picker showed. An entry without a
kind, or with a kind that the app's `@k2b/cloud` version does not know yet,
shows a key icon and no label. A form that renders its own rows for
`PrincipalPicker` selections, such as the AI cost limit rules, keeps
`serviceAccountKind` from `onSelect` and uses the same icons and labels.

On narrow screens the name and the label stay on one line. When both do not
fit, each gets an equal share and the shorter one stays whole.

### Show who a group grant reaches

A group row has a “Members” toggle beside the group name. It expands a list
below the row of the people who currently receive access through the group:
its direct members and the members of nested groups, the same users that
access resolution matches. The list starts with how many people that is and
shows 20 of them at a time; further pages load only when the viewer asks for
them. The editor needs no extra props or server routes for this.

The first page loads when the row appears, so the list usually opens
complete. The row itself never changes when it arrives: the toggle keeps its
label and stays whole on narrow screens, and the group name truncates
instead. Only the viewer's own selection pushes the rows below down.

The editor reads members from the Accounts entity search in the browser, with
the viewer's own [directory visibility](#discover-principals-safely). Full
user accounts see the count and the names. Guest accounts are refused member
lists by the server, so the expanded list says that their account cannot see
the members. Applications cannot widen this from the client.

For a directory (FreeIPA) group, the expanded list also says that local
accounts, such as guests, cannot be members and need a direct grant. Cloud
rejects local users in directory groups, so a person missing from the list
is not covered by the group grant. Change the membership in the directory or
grant the person directly.
