---
title: Find a Code service account
navTitle: Code account handles
section: Identity and access
order: 359
description: Find Code accounts by their copyable handle and show owner titles only within managed target resources.
tags: [code, identity, permissions, service-accounts]
updated: 2026-11-04
---

# Find a Code service account

Code of a resource or an app runs as a credentialless service account. Its Code
page shows a copyable handle such as `code-7k2q9m4xwt`, even before its first
run. The handle identifies the account; knowing it grants no access. Personal
Code runs as its person and has no service-account handle.

Ask the person who manages the target to add that account through the target's
normal access editor: with **Add service account**, or by typing the handle
into the search for people, which asks the same targeted lookup and adds the
hit under **Service accounts**. Grants continue to refer to the account UUID, so a handle
never replaces a principal ID in a stored grant.

## Search with the target

`GET /api/accounts/entities` accepts `target_type` and `target_id` together.
A Code account matches only its complete, case-sensitive handle in `search`.
The server checks Manage through the target's own resource reader before
including that account, so the target type needs a `reader`. Studio apps
(`assistant.app`) answer through `app.read`, which returns the person's own
level and nothing for apps they cannot open. No target, no Manage, a name, a UUID, or a partial
handle never finds a Code account. Other directory results retain their
existing visibility rules.

Handle lookups share a Valkey budget per person across all targets. They use
`security.rate_limit_per_second`; exceeding it returns `429 RATE_LIMITED`.
A disabled account remains findable by its exact handle, with status `disabled`
and a localized description. Deleted accounts return no match.

The matched `serviceAccount` contains its UUID, `handle`, localized `name`,
`description`, and `status`. Clients pass the UUID to grant operations.
`cld <app> access grant … --service-account <handle>` uses the same lookup when
the command's resource resolver supplies `AccessResource.target`.

## Return names from the authorized target

Call `resolveDisplayNames(entries, { canManageTarget, locale, cloudAdmin })`
from `@k2b/cloud/server` after your service checks the viewer's current local
permission. `canManageTarget` is the result of that check, never client input
or a Cloud-admin role. It defaults to false.

For resource Code, managers receive `Code of <owner title>`; other viewers
receive only a localized resource-type label. An app's Code is named
`Code of <App>` for everyone. Its administration link is returned only when
`cloudAdmin` is true. Resource links use the owner's registered Code page and
are returned only in a managed target context.

Resolved rows include `serviceAccountKind`, `serviceAccountHandle`,
`serviceAccountDescription`, and an optional `serviceAccountHref`. They contain
no separate private owner-title field. Never forward a manager's response to a
different viewer. Name resolution adds no SQL statements or owner-app calls:
the existing account query reads the snapshot alongside the account kind.

The previous `POST /api/resources/code-access/accounts` route is removed.
Supply authorized names with the target's access list instead.

## Keep owner titles current

Core sets a title snapshot when it creates the Code and its account. It refreshes
that snapshot while checking an owner it already reads. When your application
renames a declared Code owner, update its snapshot in the same transaction:

```ts
import { codeOwnerTitleChanged } from "@k2b/cloud";

await sql.begin(async (tx) => {
  await tx`UPDATE inventory.items SET title=${title} WHERE id=${id}`;
  await codeOwnerTitleChanged(tx, { type: "inventory.item", id }, title);
});
```

The function accepts only this application's declared `code.owners`. It does
nothing when that owner has no Code. Keep the owner's existing permission check
before this transaction. Technical owner names remain `code:<type>:<id>` or
`code:app:<appId>`; account binding columns remain empty.

Resource Types may declare final generic labels in `codeAccount: { name,
description }`, including translated labels in `presentation.translations.<locale>.types`.
For example, Mail supplies “Code eines Postfachs” and “Dienstkonto eines Postfachs”.
These labels contain only the type, never a resource title. This avoids guessing
grammatical gender or genitive forms from the type title. Types without labels
use the generic resource wording followed by their localized type title.

## Core AI permission dialogs

Core uses the same entity endpoint for `core.ai.skill` and `core.ai.project`.
Its local Manage adapter checks the current Skill or Project grants, or the
Cloud administrator's existing recovery authority, and verifies that the
target still exists. `CoreApiOptions.principalSearchTarget` supplies this
adapter when Core builds its API. Return `undefined` for other target types
to use their declared resource reader; `false` denies the lookup. The shared
endpoint retains exact-handle matching and its user-wide Valkey budget.

Resource-bound API-key accounts have no handle: the database permits this
column only for `kind = 'code'`. This lookup does not accept their UUID or
introduce another identifier.
