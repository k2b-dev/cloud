---
title: Resource API keys
navTitle: Resource API keys
section: Identity and access
order: 350
description: Create API keys for one application resource without bypassing resource authorization.
tags: [identity, service-accounts, api-keys]
updated: 2026-07-27
---

# Resource API keys

Cloud uses service accounts for credentials that are not browser sessions.

Your application receives the resulting actor. Cloud stores the service
account and issues the API key.

## Choose the identity

Cloud has two service-account kinds:

| Kind | Identity | Grants |
| --- | --- | --- |
| `user_delegated` | A credential acting for one user | The delegated user's live grants |
| `resource_bound` | A machine identity bound to one app resource | Explicit service-account grants |

Personal API keys use a user-delegated service account. Resource API keys use
a resource-bound service account.

Do not combine the delegated user's grants with the service account's grants.
See [Resource authorization](/en/docs/identity/authorization#limit-resource-bound-credentials)
for the complete binding, grant, and scope check.

## Create a resource API key

A resource API key gives an integration access to one application resource.

Each create, list, and revoke route requires a user-backed actor with `admin`
permission on that resource.

Provision one resource-bound service account in the application's serialized
resource lifecycle:

```ts
const existing = await serviceAccounts.getByResource({
  appId: "inventory",
  resourceType: "item",
  resourceId: item.id,
});

const serviceAccount = existing
  ? ok(existing)
  : await serviceAccounts.createResourceBound({
      name: `${item.name} API access`,
      appId: "inventory",
      resourceType: "item",
      resourceId: item.id,
      createdBy: user.id,
    });

if (!serviceAccount.ok) return serviceAccount;
```

Retain the selected service-account ID with the application resource.
`getOrCreateResourceBound()` is a convenience lookup. It is not a database
uniqueness boundary. Serialize provisioning when duplicates would be
incorrect.

Grant the service-account principal a stable maximum permission through the
application's resource adapter. For example, grant `admin` when this
integration family may create read, write, or admin keys.

Several keys can share the account. Each key scope can only lower the stable
grant. Creating or revoking a key does not reconcile the grant.

Before creating a key, load the selected account and verify its exact binding:

```ts
const account = await serviceAccounts.get({ id: serviceAccountId });

if (
  !account ||
  account.status !== "active" ||
  account.kind !== "resource_bound" ||
  account.appId !== "inventory" ||
  account.resourceType !== "item" ||
  account.resourceId !== item.id
) {
  return fail(err.notFound("Resource service account"));
}
```

Then create the credential:

```ts
const created =
  await serviceAccountCredentials.createResourceApiToken({
    serviceAccountId: account.id,
    actor: user,
    name: "Warehouse sync",
    expiresAt: "2027-01-01T00:00:00.000Z",
    scopes: ["write"],
  });

if (!created.ok) return created;
```

| Input | Required | Meaning |
| --- | --- | --- |
| `serviceAccountId` | Yes | Active resource-bound account |
| `actor` | Yes | User creating the key |
| `name` | Yes | Integration name |
| `expiresAt` | No | ISO timestamp or `null` |
| `scopes` | No | Permission caps such as `read`, `write`, or `admin` |

The raw token is returned once. Later list operations return metadata and the
token prefix.

List keys with resource filters:

```ts
const page = await serviceAccountCredentials.listOverview({
  pagination: { page: 1, perPage: 100 },
  filter: {
    serviceAccountKind: "resource_bound",
    credentialStatus: "active",
    appId: "inventory",
    resourceType: "item",
    resourceId: item.id,
  },
});
```

Map each credential's scopes to one `PermissionLevel` before returning it to
`ResourceApiKeys`. Use the highest recognized value: `admin`, then `write`,
then `read`, otherwise `none`.

Before revoking a credential, load its overview and verify that it belongs to
the requested resource. `revoke()` only checks the credential ID and current
status.

```ts
const credential = await serviceAccountCredentials.getOverview({
  id: credentialId,
});

if (
  !credential ||
  credential.serviceAccount.kind !== "resource_bound" ||
  credential.serviceAccount.appId !== "inventory" ||
  credential.serviceAccount.resourceType !== "item" ||
  credential.serviceAccount.resourceId !== item.id
) {
  return fail(err.notFound("API key"));
}

const revoked = await serviceAccountCredentials.revoke({
  credentialId,
  actor: user,
});

if (!revoked.ok) return revoked;
```

Revocation disables the secret. It does not remove the service account or its
resource grant.

Every request made with the key must match its exact `appId`, `resourceType`,
and `resourceId`. Resolve the service-account grant and cap it with the
credential scope. Scopes never create access.

Use the canonical
[resource-credential authorization recipe](/en/docs/identity/authorization#limit-resource-bound-credentials)
inside the permission-aware application service.

## Add the API-key UI

Use `ResourceApiKeys` in the resource's admin-only settings surface:

```tsx
import {
  ResourceApiKeys,
} from "@k2b/cloud/access/ui";

<ResourceApiKeys
  title="API keys"
  description="Keys for integrations that work with this item."
  initialKeys={apiKeys}
  createKey={async (input) => {
    const response = await apiClient[":id"]["api-keys"].$post({
      param: { id: item.id },
      json: input,
    });
    if (response.status !== 201) {
      throw new Error("Failed to create API key.");
    }
    return response.json();
  }}
  revokeKey={async (credentialId) => {
    const response = await apiClient[":id"]["api-keys"][":credentialId"].$delete({
      param: { id: item.id, credentialId },
    });
    if (!response.ok) throw new Error("Failed to revoke API key.");
  }}
/>
```

The component owns the create dialog, permission and expiry inputs, local list
updates, revoke confirmation, and one-time token display. The application owns
the API routes and their authorization.

Keep human and group grants in `PermissionEditor`. Hide service-account entries
from that editor unless administrators need to manage them directly.

`ResourceApiKeys` accepts:

| Prop | Use |
| --- | --- |
| `initialKeys` | Credential metadata with a derived `permission` |
| `permissionOptions` | Optional labels and allowed grantable levels |
| `createKey(input)` | Create a key and return its metadata plus the raw token |
| `revokeKey(id)` | Revoke one key |
| `title` / `description` | Optional resource-specific copy |
