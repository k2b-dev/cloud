---
title: Define an application
navTitle: Define an application
section: Build an app
order: 120
description: Declare application identity, routes, navigation, and platform integrations with defineApp().
tags: [applications, define-app, configuration]
updated: 2026-10-20
---

# Define an application

`defineApp()` declares the stable platform identity of one independently
released HTTP service. Cloud can discover and present the service from this
declaration without importing its source code.

It creates the typed application APIs used by the entry point. It does not
create Hono routes, add middleware, or start the service.

## Declare the required fields

```ts
import { defineApp } from "@k2b/cloud";

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

## Keep the shell during page navigation

Set `pageSwap: true` to swap `Layout` pages within the app. The default is
`false`. The rail, phone tab bar, panel slot, and provider document stay mounted.
The next server page replaces the content column and its islands.

`focusMode` pages and links to other apps load a document. Changes to the user,
locale, page theme, shell providers, navigation apps, or build also load a
document. Server route policies still authorize every request.

See [URL state and navigation](/en/docs/frontend/url-state-and-navigation#cloud-page-swaps)
for the replaced content and unsaved-input guards.

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
| `requiresRoles` | No | — | Show the link, the application's [Help](/en/docs/platform/help#who-can-read-help), and its [Assistant Skills](/en/docs/platform/assistant-skills#who-can-use-an-app-skill) only for matching platform roles; `guest` matches guests |
| `badge` | No | — | Route whose count the app bar and app grid show on the icon; see [Show a count on the app icon](/en/docs/frontend/layout-and-navigation#show-a-count-on-the-app-icon) |

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
    id: "inventory",
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
Tabler `icon`. Add a stable group `id` when its label is translated through
`presentation`.

An application contributing AI administration can set `section: "ai"` on its
group. The layout adds those links to the existing AI administration section.
Route and resource authorization still belong to the application; this field
only selects where authorized navigation is displayed.

## Add pages to the mobile app

> **Preview:** the mobile app is not released yet. This option may still
> change until it is, without counting as a breaking change.

`pwa` adds the application to the installation's
[mobile app](/en/docs/frontend/mobile-app-pages):

```ts
pwa: { requiresRoles: ["user"] },
```

Cloud appends `/pwa/<id>` to `routes` and publishes the part in the registry.
The mobile app lists it with the application's `name`, `icon`, and
`description`. `requiresRoles` is optional and, like `nav.requiresRoles`,
controls only visibility; routes and services still authorize.

`/pwa` is reserved. `defineApp()` throws at startup when `routes` lists `/pwa`
or a path below it; the only exceptions are the mobile app's own `/pwa` and
Core's `/pwa/_auth`. It also throws when an application declares `pwa` with the
id `pwa`, `settings`, or `offline`, or with an id that is not lowercase letters,
digits, and hyphens starting with a letter.

## Translate registered presentation

Keep the complete base presentation in the normal application declaration.
`presentation` adds partial locale overlays for `name`, `description`, admin
group and link labels, and legal-link labels:

```ts
presentation: {
  baseLocale: "en",
  translations: {
    de: {
      name: "Inventar",
      adminGroups: { inventory: "Inventar" },
      adminLinks: { "/admin/inventory/warehouses": "Lager" },
      legalLinks: { "/inventory/privacy": "Datenschutz" },
    },
  },
},
```

Group labels are keyed by `adminNav[].id`; link labels are keyed by their
stable `href`. Unknown references, invalid locale tags, duplicate canonical
locales, and oversized catalogs fail during startup. Runtime consumers receive
the exact locale, its language ancestors, then the base declaration per field.
See [Internationalization](/en/docs/build/internationalization) for ownership
and fallback conventions.

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

`accent` drives the app's identity text and selection color. Cloud automatically
derives readable text with at least 4.5:1 contrast (WCAG AA) and soft selection
fills for light and dark mode. Any six-digit hex accent is accepted. A light
accent such as yellow is darkened only as far as needed.
The accent colors the app ink, selected navigation and content rows, selected
tabs, view tabs and segments, active filter chips, and the app's icon tiles.
It never colors buttons, inputs, checkboxes, switches, focus rings, or status;
link text stays body ink, and only its underline takes the app ink. See
[Colors and selection](/en/ui/surfaces/color).
The accent also reaches dialogs and sheets opened from the app's pages,
with no application code.

| Background field | Default | Accepted range |
| --- | --- | --- |
| `to` | `from` | Six-digit hex color |
| `via` | `#ffffff` | Six-digit hex color |
| `angle` | `135` | `0–360` |
| `strength` | `20` | `0–100` |

`strength` is applied as declared in light mode. Dark mode uses half of that
strength so application identity remains visible without overpowering the
shared dark surface hierarchy.

Signed-in people see the background behind the app bar from 768 px and, from
1024 px, also around the app area. Anonymous pages show it around the header
and content from 768 px. Narrower screens use the flat work surface in both
light and dark mode.

## Declare platform integrations

The remaining options declare application-owned contributions:

| Option | Contribution | Reference |
| --- | --- | --- |
| `settings` | Typed runtime configuration | [Settings](/en/docs/platform/settings) |
| `platformPermissions` | Requested platform permissions: `"mail:send"` to send outgoing mail, `"mail:read"` to read other apps' mail an operator grants | [Outgoing mail](/en/docs/platform/outgoing-mail) |
| `notifications` | Notification definitions the application may send | [Notifications](/en/docs/platform/notifications) |
| `skills` | Assistant Skills the application ships, from `src/skills.ts` | [Ship Assistant Skills](/en/docs/platform/assistant-skills) |
| `widgets` | Dashboard widget endpoints | [Dashboard widgets](/en/docs/platform/dashboard-widgets) |
| `legalLinks` | Application-owned legal and information links | — |
| `presentation` | Localized overlays for registered human-facing app metadata | [Internationalization](/en/docs/build/internationalization) |
| `openapi` | Public OpenAPI document path | [Typed HTTP APIs](/en/docs/server/http#publish-openapi) |
| `pwa` | Pages in the mobile app (preview) | [Pages in the mobile app](/en/docs/frontend/mobile-app-pages) |

Definitions establish ownership and types. They do not run an operation.

For example, declare settings and notifications in `defineApp()`:

```ts
export const app = defineApp({
  // required fields
  settings: inventorySettings,
  notifications: inventoryNotifications,
});
```

Dashboard widget entries contain an `id`, an absolute endpoint `path`, and
optional `title`, `description`, `sizes`, `defaultSize`, `suggest`,
`requiresRoles`, and `settings`. `presentation` carries the deprecated zone
and span recommendations for saved boards. See
[Dashboard widgets](/en/docs/platform/dashboard-widgets) for the declaration
limits. The endpoint authorizes every request and every selected resource.

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

`appRoot` is the SSR base for component IDs and development assets. It defaults
to `process.cwd()`, which is the standalone project root in the normal setup.
Island discovery scans `APP_DIR/src` (or `appRoot/src` when `APP_DIR` is unset)
and the installed Cloud framework source. Development and production scripts
resolve `APP_DIR` before importing application configuration, so sibling apps
are not scanned. Ordinary `@k2b/ui` components are bundled through imports;
the UI package and its fixtures do not need a discovery root.

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
import type { AppContext } from "@k2b/cloud/server";

type InventoryContext = AppContext<typeof app>;
```

`AppContext` only describes the request context type. Register
`middleware.settings()` before every route that reads `c.get("settings")`.

See [Request middleware](/en/docs/server/middleware).
