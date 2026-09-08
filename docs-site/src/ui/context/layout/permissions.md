# Access controls

Cloud provides three focused components for resource access:

- `PermissionEditor` edits direct grants;
- `EntitySearch` selects one principal;
- `ResourceApiKeys` manages resource-bound machine credentials.

The application owns the resource id, permission checks, and server mutations. Cloud identity remains authoritative for principals and credentials.

## Use the access components

Use `PermissionEditor` for a complete sharing surface. Use `EntitySearch` alone when a workflow needs to choose one user, group, service account, or audience without editing grants.

Use `ResourceApiKeys` for integrations that need machine access to one resource. Do not create or reveal credentials in `PermissionEditor`.

## Import

```tsx
import {
  PermissionEditor,
  ResourceApiKeys,
  type ResourceApiKey,
  type ResourceApiKeyPermissionOption,
} from "@k2b/cloud/access/ui";
import {
  EntitySearch,
  type EntitySearchPrincipal,
} from "@k2b/cloud/account/ui";
```

## Edit direct grants

Pass stored grants through `initialEntries`. Close over the current resource id in `grantAccess`, `updateAccess`, and `revokeAccess`.

The editor updates its local list only after a callback succeeds. `canEdit={false}` keeps the list read-only.

`allowedLevels` controls the offered permission levels and their labels. The first level is granted when a principal is added. The user can then change it from the entry row.

Public access and service accounts are opt-in through `allowPublic` and `allowServiceAccounts`.

Authorization still belongs in the service. Rendering an editor does not grant the current actor permission to change access.

## Select a principal

`EntitySearch` includes no principal kinds by default. Enable only the kinds the workflow accepts.

Users and groups can be limited by provider. Existing ids can be excluded. Real directory searches begin after two characters and use the Cloud accounts endpoint.

The accounts endpoint scopes discovery to the current account before applying
those component filters. Full user accounts can search the directory. Guest
accounts can find only themselves and their direct or recursively inherited
groups; group results do not reveal members. Anonymous callers and userless
service accounts cannot search identities.

The include and exclude props refine that server-authorized result. They are
presentation controls, not authorization boundaries.
Relationship-scoped account searches remain available only to full user
accounts.

`onSelect` receives a discriminated `EntitySearchPrincipal`.

## Manage resource API keys

Pass existing credentials through `initialKeys`. Implement `createKey` and `revokeKey` with the application service for the current resource.

`createKey` returns the stored credential and the plain token. The component shows the token once. It cannot recover it later.

Use `permissionOptions` to limit and explain the levels supported by the resource.

## Accessibility

Permission labels must describe capability, not color. Principal rows and destructive actions already use buttons; keep custom permission labels specific and short.

The API-key creation flow must explain that the token is shown once.

## Runtime

These components are interactive and require hydration.

`PermissionEditor` and `EntitySearch` query Cloud identity in the browser. API-key creation and revocation call the application callbacks. Server-side authorization must run again in every callback target.

There is no catalog-safe substitute for those dependencies. A documentation
page without the real accounts route and resource mutation service must show a
static integration reference, not a `PermissionEditor` whose callbacks return
fabricated successes. The same rule applies to API-key creation: never display
a fixture token as if the backend created a credential.

## Example

```tsx
<PermissionEditor
  initialEntries={entries}
  allowPublic
  allowedLevels={[
    { level: "read", label: "View" },
    { level: "write", label: "Edit" },
    { level: "admin", label: "Manage" },
  ]}
  grantAccess={(principal, permission) =>
    access.grant(resourceId, principal, permission)
  }
  updateAccess={(accessId, permission) =>
    access.update(resourceId, accessId, permission)
  }
  revokeAccess={(accessId) =>
    access.revoke(resourceId, accessId)
  }
/>
```

For a dialog that saves permissions with other fields, callbacks may update a
local draft. `grantAccess` receives an optional third argument containing the
selected principal's `displayName`; keep it on the draft `AccessEntry` so newly
selected users and groups remain recognizable. It is presentation metadata,
not an authorization input. Commit the draft through the owning resource
service when the whole form is saved; cancelling must discard it.
