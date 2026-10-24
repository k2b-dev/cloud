---
title: App access
navTitle: App access
section: Identity and access
order: 315
description: Declare who may use an application and keep entry and discovery decisions consistent.
tags: [identity, applications, authorization]
updated: 2026-10-22
---

# App access

Declare `access` in `defineApp()` to choose who may use your application.
Cloud evaluates this rule before application code and uses it to filter
application discovery. Resource permissions still decide what a caller may do
inside the application.

## Choose a fixed rule

```ts
import { appAccess, defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-packages",
  description: "Track stock and warehouse movements.",
  baseUrl: "http://app-inventory:3000",
  routes: ["/app/inventory", "/api/inventory"],
  access: appAccess.signedIn(),
});
```

| Rule | Who may use the app |
| --- | --- |
| `appAccess.signedIn()` | Any resolved signed-in identity, including service accounts |
| `appAccess.noGuests()` | Signed-in identities except people with a guest profile, including credentials delegated by a guest |
| `appAccess.roles(["admin"])` | Identities whose effective user has one of the listed Cloud roles |
| `appAccess.grants()` | Identities with `read` or `admin` on the application's access list |

`roles()` accepts Cloud roles, not application-defined roles. Use a group grant
for an application-specific audience. A standalone service account has no user
roles; it can use `signedIn`, `noGuests`, or an explicit grant. A Cloud app
session never regains the Cloud administrator role through this check.

Credentials retain their scopes and resource binding. App access opens the
application; it does not widen a key or replace route and resource checks.

## Preserve public routes

Declare routes that have their own public or specialized authentication:

```ts
access: appAccess.signedIn({
  publicRoutes: ["/inventory/shared/:token", "/api/inventory/webhook"],
}),
```

These paths bypass only the app entry rule. The application's route middleware
still validates share tokens, webhook signatures, or other credentials.
Do not exempt an entire API prefix to accommodate one public endpoint.

Framework assets and readiness remain available independently of app access.
Framework endpoints that contain app information or execute operations also
participate in the access decision.

## Use a configurable list

`appAccess.grants()` declares a platform-evaluated list, not a callback to
application code. `read` means **Use**; `admin` means **Manage access** and also
includes use. Installation administrators do not receive app use automatically.

When moving from a fixed rule to a list, declare the previous rule as `until`:

```ts
access: appAccess.grants({ until: appAccess.signedIn() }),
```

Until the list is first saved, the previous rule remains effective. Once saved,
only the list applies. Without `until`, an unconfigured list grants nobody
access. Do not substitute `signedIn()` for a previously narrower rule.

The snapshot's `configured` field becomes `true` on the first successful list
edit. Reading the list does not configure it. A failed edit leaves the previous
rule in effect. For a `signedIn()` predecessor, the editor initially shows an
inherited signed-in **Use** entry; the first save preserves it as a real grant.
Remove that entry deliberately when narrowing use. Other fixed predecessors
remain effective until first save but do not create a signed-in grant.

If no manager exists yet, an installation administrator must assign the first
manager through explicit repair. The predecessor permits use, not management.
All built-in applications keep fixed rules in the first rollout; the shared
editor does not make them configurable automatically.

### Restrict who may manage the list

Users, groups, and service accounts may receive **Use** (`read`) or **Manage
access** (`admin`). The signed-in audience may receive only Use. Public grants
and a separate Write level are not supported for app access.

An optional `canManage(authority, { db })` callback adds an application-owned
restriction to a Manage access grant. For example, an app can limit ordinary
management to managers whose effective user is a Cloud administrator:

```ts
import { appAccess } from "@k2b/cloud";
import { userFromActor } from "@k2b/cloud/server";

export const access = appAccess.grants({
  until: appAccess.signedIn(),
  canManage: (authority) =>
    userFromActor(authority.actor)?.roles.includes("admin") === true,
});
```

Pass `access` to `defineApp()`. Returning `true` never substitutes for a
management grant or the credential's write authority. The callback runs in
the owning application for both list reads and edits; it is not part of the
serializable app-use rule and cannot grant use. Core repair is a separate,
explicit administration path and does not run this callback.

SQL-backed restrictions must use the callback's `db` argument and pass it to
any domain service they call. During an edit it is the connection holding the
app-list transaction. Opening another connection from the global pool can
block concurrent edits; a callback that only checks the resolved authority
may omit the second argument.

## Add the editor to application settings

Import `AppAccessEditor` from `@k2b/cloud/access/ui` inside a Solid island:

```tsx
// Access.island.tsx
import {
  AppAccessEditor,
  type AppAccessEditorProps,
} from "@k2b/cloud/access/ui";

export default function Access(props: AppAccessEditorProps) {
  return <AppAccessEditor {...props} />;
}
```

Render it from the application's settings page with `app={app.meta}`. For
SSR, load the authorized initial snapshot with `readAppAccess` from
`@k2b/cloud/services` and pass it as `initial`:

```ts
import { auth } from "@k2b/cloud/server";
import { AppAccessManagementError, canManageAppAccess, readAppAccess } from "@k2b/cloud/services";
import { access, app } from "../config";

// Inside the settings page's async SSR handler, with request context c:
const authority = auth.getAuthority(c);
let showAccess = await canManageAppAccess(authority, app.meta, access.canManage);
const initial = showAccess
  ? await readAppAccess({ app: app.meta, authority, canManage: access.canManage }).catch((error: unknown) => {
      if (!(error instanceof AppAccessManagementError && error.status === 403)) throw error;
      showAccess = false;
      return undefined;
    })
  : undefined;
```

In the page's returned render function, use
`<Show when={showAccess}><Access app={app.meta} initial={initial} /></Show>`
and show the Access tab only when `showAccess` is true. The read passes the declaration's
`canManage` callback explicitly because `app.meta` contains only the
serializable rule. Apply the page's authenticated route
policy. The example handles a permission change between these two reads as
loss of management and renders the remaining settings without the Access tab.
Unexpected read failures reach the page's error handling and need a visible
error and retry.
See [SSR pages and routing](/en/docs/frontend/ssr-pages-and-routing).

The component accepts:

| Prop | Behavior |
| --- | --- |
| `app` | Required `{ id, name, access? }`; fixed or undeclared rules render explanatory text instead of an editable list |
| `initial` | Authorized `AppAccessSnapshot`; without it a grants editor reads the list after browser mount |
| `onAccessLost` | Called when an edit removes app use or a follow-up read loses management; defaults to reloading the current page |
| `repair` | Selects explicit Core repair; reserved for an administration surface and still authorized by the server |

The snapshot includes `entries`, matching `ownEntryIds` (including group
grants), `configured`, `hasEffectiveManager`, `inheritedSignedIn`, and `canUse`, alongside `appId` and
`name`. Group entries include `groupMemberCount` (distinct people reached through
nested membership). Entries also include `effectiveManager` for platform
eligibility: expired people, empty groups and disabled accounts do not count.
These presentation fields do not replace the server check or an app-owned
`canManage` restriction. Use the snapshot for authorized initial rendering. The editor uses the inherited
UI locale and reads the canonical list
after changes. Keep its default reload behavior or make `onAccessLost` return
to a page that rechecks authorization.

A failed initial read shows **Reload**. A missing or changed grant requires
**Reload** before another edit; loss of management shows a terminal message.
Other failed edits offer a retry. If a write response is lost, the editor reads the list to check
whether the change committed before allowing another write. If that read also
fails, editing stays blocked until **Reload** succeeds. Custom clients must
also read the current list before retrying an uncertain write.

### Use the shared management route

The editor and [app access CLI commands](/en/docs/platform/cli-modules#add-app-access-commands)
use `/_cloud/app-access/:appId`. For ordinary management, Core returns a
same-origin HTTP 307 redirect for GET and POST to the owning application's
framework route. The redirect preserves the method and POST body. For
`routes: ["/app/inventory", "/api/inventory"]`, that route is
`/app/inventory/_cloud/access/inventory`. Declare a concrete first route
prefix; the framework mounts this endpoint before the app-use gate and checks
management authority independently. Do not mount a second management API or
add the endpoint to `publicRoutes`.

Only `?repair=1` on the Core route selects administrator repair. Ordinary
management never falls back to repair after a denial. Repair grants no app
use: the administrator needs an applicable app grant to use a configured app.
Administrators can open **Administration → Apps → Repair access** even when
the app is absent from their launcher. Fixed rules cannot be repaired into
lists; changing a fixed rule requires an application declaration update.

### Save without losing the last manager

Each list edit serializes changes for the app and commits the grant, the
first-configuration marker, audit records, and the change notification outbox
entry in one transaction. Audit actions are `app.access.granted`,
`app.access.updated`, and `app.access.revoked`; administrator repair records
`via: "platform-admin"`. Audit or outbox failure rolls the edit back.

Every edit must leave an effective manager. Empty groups, expired people,
disabled service accounts, and user-delegated or resource-bound keys cannot
serve as the last manager. A group with an unexpired member, including nested
membership, or an active standalone or agent account can. A violating edit
returns HTTP 409 with `code: "LAST_MANAGER"`; add another manager first. This
check also applies during repair and first configuration.

With a `canManage` restriction, Cloud also needs proof that a remaining
manager passes it: the current caller with its unchanged authority, an active
web or mobile session, or an active standalone or agent API credential. The
check reloads identity and preserves credential limits. It examines at most
100 stored session and credential candidates; an unproved result rejects the
edit. An offline manager or an OAuth-only manager might therefore need to sign
in before another manager can leave. Keep the callback deterministic and free
of side effects; do not rely on request-specific provenance for this check.
Core repair cannot run the app's callback and applies the platform eligibility
check instead. Later changes to groups, accounts or credentials can still
require administrator repair.

The editor confirms removal or downgrade of an entry applying to the caller.
Cancellation keeps the entry; confirmation still passes through the server's
last-manager check. Losing Use returns the caller to normal page authorization.

## Understand denial and discovery

Without app access, an application does not appear in the launcher, rail,
search, dashboard, Help, Skills, widget selection, Assistant tools, or CLI
plugin list. A direct link may name the application and whom to contact; it
must not show application content or offer a request-access action.

API and CLI entry attempts return HTTP 403 with `code: "app_access_denied"`,
the application ID, and a recovery message. Cross-app calls check access both
before issuing an invocation and when the target receives it. Permission
lookup errors deny access.

Changes take effect on the next request. Open live connections must revalidate
when access changes and at least once per minute, including current account,
role, group, and credential state. Failed revalidation closes the connection.

## Check access inside a service

Use `canUseApp(authority, app)` or `usableAppIds(authority, apps)` from
`@k2b/cloud/services` when a service needs the same app-entry decision as the
platform. Pass the resolved request authority so credential limits remain in
effect; continue to check the operation's resource permissions separately.

Inside a SQL transaction, pass its connection as the optional third argument:
`canUseApp(authority, app, { db })` or `usableAppIds(authority, apps, { db })`.
This keeps grant reads in the transaction and avoids waiting for a second
pooled connection. Outside a transaction, omit the option. Framework-managed
invocation issuance carries its transaction through identity and access checks
automatically.

## Upgrade an existing application

In this release, an application without `access` keeps its existing entry and
discovery behavior and logs a startup warning. Declare a rule deliberately:
`nav.requiresRoles` was a visibility filter and may not describe every caller
that already uses the API. Inventory public routes and test service accounts,
delegated credentials, guests, and mobile sessions before shipping the rule.

See [Route policies](/en/docs/identity/route-policies) and
[Resource authorization](/en/docs/identity/authorization) for the checks that
continue inside the app.
