---
title: Define an application
navTitle: Define an application
section: Build an app
order: 120
description: Declare application identity, routes, navigation, and platform integrations with defineApp().
tags: [applications, define-app, configuration]
updated: 2026-08-12
---

# Define an application

`defineApp()` declares the stable platform identity of one independently
released HTTP service. Cloud can discover and present the service from this
declaration without importing its source code.

It creates the typed application APIs used by the entry point. It does not
create Hono routes, add middleware, or start the service.

## Declare the required fields

```ts
import { defineApp } from "@valentinkolb/cloud";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-packages",
  description: "Track stock and warehouse movements.",
  baseUrl: "http://app-inventory:3000",
  routes: ["/api/inventory"],
});
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Stable machine identity |
| `name` | Yes | Name shown by platform surfaces |
| `icon` | Yes | Tabler icon class used across Cloud and as the favicon on rendered app pages |
| `description` | Yes | Short application description |
| `baseUrl` | Yes | Internal address used by the gateway |
| `routes` | Yes | Public path prefixes routed to the service |

Use an address that resolves from the gateway container for `baseUrl`. Do not
use the public browser URL.

Cloud generates a transparent favicon with a theme-adaptive Cloud gradient for
rendered application pages from `icon`: blue in light mode and blue-white in
dark mode. Core pages keep the operator-configured Cloud favicon.

Declare only prefixes the application serves. See
[Routes and discovery](/en/docs/build/routing).

## Set the SSR asset prefix

Applications that render pages set `basePath`:

```ts
basePath: "/app/inventory",
```

Cloud then mounts generated SSR assets below
`/app/inventory/_ssr`. The Core application omits `basePath` because it owns the
global SSR asset path.

See [SSR pages and routing](/en/docs/frontend/ssr-pages-and-routing).

## Add global navigation

`nav` contributes one application entry:

```ts
nav: {
  href: "/app/inventory",
  match: "/app/inventory",
  section: "primary",
  requiresAuth: true,
  requiresRoles: ["user"],
},
```

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `href` | Yes | — | Link opened from navigation |
| `section` | Yes | — | `"primary"`, `"more"`, or `"hidden"` |
| `match` | No | `href` without its query | Path used for active navigation |
| `requiresAuth` | No | — | Hide the link from anonymous visitors |
| `requiresRoles` | No | — | Show the link only for matching platform roles |

Navigation visibility is not authorization. Protect the destination with
[route policies](/en/docs/identity/route-policies).

## Add administration pages

Use `adminHref` for one administration entry:

```ts
adminHref: "/admin/inventory",
```

Use `adminNav` for grouped links:

```ts
adminNav: [
  {
    label: "Inventory",
    links: [
      {
        label: "Warehouses",
        href: "/admin/inventory/warehouses",
        icon: "ti ti-building-warehouse",
      },
    ],
  },
],
```

Each group needs a `label` and `links`. Each link needs a `label`, `href`, and
Tabler `icon`.

## Set the application appearance

`appearance` supplies the accent and optional page background:

```ts
appearance: {
  accent: "#2563eb",
  background: {
    from: "#dbeafe",
    via: "#ffffff",
    to: "#ecfeff",
    angle: 135,
    strength: 20,
  },
},
```

Colors use six-digit hex values. `accent` and `background.from` are required
when their containing object is present.

| Background field | Default | Accepted range |
| --- | --- | --- |
| `to` | `from` | Six-digit hex color |
| `via` | `#ffffff` | Six-digit hex color |
| `angle` | `135` | `0–360` |
| `strength` | `20` | `0–100` |

`strength` is applied as declared in light mode. Dark mode uses half of that
strength so application identity remains visible without overpowering the
shared dark surface hierarchy.

## Declare platform integrations

The remaining options declare application-owned contributions:

| Option | Contribution | Reference |
| --- | --- | --- |
| `settings` | Typed runtime configuration | [Settings](/en/docs/platform/settings) |
| `notifications` | Notification definitions the application may send | [Notifications](/en/docs/platform/notifications) |
| `widgets` | Dashboard widget endpoints | [Dashboard widgets](/en/docs/platform/dashboard-widgets) |
| `legalLinks` | Application-owned legal and information links | — |
| `openapi` | Public OpenAPI document path | [Typed HTTP APIs](/en/docs/server/http#publish-openapi) |

Definitions establish ownership and types. They do not run an operation.

For example, declare settings and notifications in `defineApp()`:

```ts
export const app = defineApp({
  // required fields
  settings: inventorySettings,
  notifications: inventoryNotifications,
});
```

Dashboard widget entries contain an `id`, an absolute endpoint `path`, and an
optional `presentation`. The endpoint decides whether the current caller may
see its result.

Legal link entries contain a `label`, `href`, and optional `icon`.

## Pair OpenAPI with the router

The application definition declares the public document path:

```ts
openapi: "/api/inventory/openapi.json",
```

The entry point passes the bare API router:

```ts
await app.start({
  fetch: router.fetch,
  openapi: apiRoutes,
});
```

Both values are required. Cloud generates the document, serves it without
application middleware, and advertises it through the registry.

Capabilities are executable code rather than static application metadata. Pass
the declaration to `app.start({ capabilities })`. Universal Search is an
optional projection of a capability Query; see
[App capabilities](/en/docs/platform/capabilities) and
[Universal search](/en/docs/platform/search).

## Override the project root only when required

`appRoot` controls where the SSR build looks for application files. It defaults
to `process.cwd()`, which is the standalone project root in the normal setup.

Set it only when the process starts from another directory:

```ts
appRoot: "/srv/inventory",
```

An incorrect root prevents application assets and islands from being
discovered.

## Returned application APIs

`defineApp()` returns:

| Value | Use |
| --- | --- |
| `app.meta` | Read the declared application metadata |
| `app.baseUrl` | Read the declared internal address |
| `app.start()` | Register and start the service |
| `app.ssr` | Create SSR route handlers |
| `app.plugin` | Build application assets |
| `app.config` | Access the generated SSR configuration |
| `app.settings` | Read or change declared settings outside a request |
| `app.notifications` | Send declared notifications |

`app._settings` exists only to carry inferred types. Do not read or assign it.

Use `AppContext<typeof app>` to expose declared settings on request context:

```ts
import type { AppContext } from "@valentinkolb/cloud/server";

type InventoryContext = AppContext<typeof app>;
```

`AppContext` only describes the request context type. Register
`middleware.settings()` before every route that reads `c.get("settings")`.

See [Request middleware](/en/docs/server/middleware).
