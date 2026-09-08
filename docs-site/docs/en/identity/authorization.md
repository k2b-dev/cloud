---
title: Resource authorization
navTitle: Resource authorization
section: Identity and access
order: 320
description: Resolve resource grants in application services for users, groups, service accounts, and public callers.
tags: [identity, authorization, permissions, services]
updated: 2026-07-27
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

Applications decide what each level means for their resources.

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
| Service account | One resource-bound machine identity |
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

For a resource-bound service account it includes:

- the direct service-account grant;
- authenticated grants;
- public grants.

Do not pass `User.memberofGroupIds`. The shared resolver reads authoritative
membership itself.

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
  const resourceCredential =
    input.actor.kind === "service_account" &&
    input.actor.delegatedUser === null
      ? input.actor
      : null;

  if (
    resourceCredential &&
    (resourceCredential.serviceAccount.kind !== "resource_bound" ||
      resourceCredential.serviceAccount.appId !== "inventory" ||
      resourceCredential.serviceAccount.resourceType !== "item" ||
      resourceCredential.serviceAccount.resourceId !== input.itemId)
  ) {
    return fail(err.forbidden("Access denied"));
  }

  const entries = await input.access.list(input.itemId);
  const granted = await getEffectivePermission({
    accessIds: entries.map((entry) => entry.id),
    subject: input.accessSubject,
  });
  const effective = resourceCredential
    ? lowerPermission(
        granted,
        permissionFromScopes(resourceCredential.scopes),
      )
    : granted;

  return hasPermission(effective, input.required)
    ? ok(effective)
    : fail(err.forbidden("Access denied"));
};
```

This order is deliberate:

1. reject a credential bound to another application or resource;
2. resolve the service-account grant through `accessSubject`;
3. lower that grant to the credential scope;
4. compare the effective permission with the operation.

The same helper accepts user and user-delegated actors. They use their user
grants and do not enter the resource-credential branch.

Collection and search endpoints must restrict the query to the bound resource
or reject the credential. Authentication alone must not expose every item.

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

Call `resolveDisplayNames()` when adapter entries do not include names.

`listUsersWithAccess()` expands direct user and nested group grants for bounded
pickers. It supports search, included and excluded user IDs, a minimum
permission, and a limit from `1` to `500`. It does not expand `public` or
`authenticated` into every account.

Keep grant editing and credential creation separate. The permission editor
must not display raw keys or own secret lifecycle.
