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
roles; it can use `signedIn`, `noGuests`, or an explicit grant. A mobile app
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
