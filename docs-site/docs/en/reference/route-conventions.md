---
title: Route conventions
navTitle: Route conventions
section: Reference
order: 1220
description: Look up the route prefixes reserved by Cloud and those owned by applications.
tags: [routes, gateway, prefixes]
updated: 2026-10-04
---

# Route conventions

Every application declares the URL prefixes it owns.

The gateway matches the longest registered prefix and proxies the unchanged
request to the application's `baseUrl`.

## Use standard application prefixes

| Prefix | Owner |
| --- | --- |
| `/app/<app-id>` | Authenticated application pages |
| `/api/<app-id>` | Application JSON API |
| `/admin/<app-id>` | Application administration |
| `/public/<app-id>/*` | Application static assets |

Declare only the prefixes the application serves.

An application with an anonymous page should declare a separate page prefix.
Do not place a page below `/public/<app-id>`; that path is for static files.

## Framework-owned paths

`app.start()` handles these before the application router:

| Path | Purpose |
| --- | --- |
| `<basePath>/_ssr/*` | Solid island chunks |
| `/_cloud/ready` | Direct process readiness for deployment health checks |
| `/public/*` | Static assets |
| `/api/_internal/search` | Search provider endpoint when enabled |
| the declared OpenAPI path | Generated OpenAPI document |

When an application has no `basePath`, its island chunks use `/_ssr/*`.

The gateway, Core, OAuth, and other platform applications also own special
top-level routes such as `/auth`, `/oauth`, and `/.well-known/...`.

Do not reuse a platform prefix.

`/_cloud/ready` is intentionally checked on the application's private service
address, not through the gateway. It responds only after `app.start()` has
completed registration and all awaited lifecycle startup work.

## Mobile app paths

> **Preview:** the mobile app is not released yet. These paths may still change
> in a minor release.

`/pwa` is the installable mobile app's scope. Only three claims are valid:

| Prefix | Owner |
| --- | --- |
| `/pwa` | The mobile app (the application `pwa`): Start, `/pwa/settings`, `/pwa/offline`, manifest, and service worker |
| `/pwa/_auth` | Core: the phone's sign-in endpoints |
| `/pwa/<app-id>` | That application's [part](/en/docs/frontend/mobile-app-pages), declared with `defineApp({ pwa })` |

A part's application id consists of lowercase letters, digits, and hyphens and
starts with a letter; `pwa`, `settings`, and `offline` cannot have a part.
`defineApp()` adds `/pwa/<app-id>` itself and throws for any `/pwa` path in
`routes`. The gateway skips every other prefix below `/pwa` with a
`reserved_prefix` route warning, also from applications that do not use
`defineApp()`.

Only the mobile app may serve a service worker below `/pwa`. The gateway
answers `403` when a browser requests a worker script there from any other
application. Only Core may send `Service-Worker-Allowed`; the gateway removes
the header from every other application's responses. So the scope `/pwa/`
keeps the mobile app's own service worker.

## Match and normalize prefixes

A prefix must start with `/`.

A trailing slash is removed except for `/`, and repeated slashes count as one:
`//app/inventory/` is `/app/inventory`. Query strings do not affect route
selection.

The gateway uses the longest matching segment path. For example,
`/app/inventory/admin` wins over `/app/inventory` when both are registered.

Exact duplicate prefixes are skipped and reported as route warnings. The first
application in the deterministic registry ordering keeps the prefix. Prefixes
below `/pwa` that the application may not claim are skipped the same way; see
[Mobile app paths](#mobile-app-paths).

## Use public IDs in resource routes

When a route addresses an application resource, use that resource's canonical
public ID in the path or query. Do not expose an internal database key merely
because the router can pass it directly to a query.

Short IDs are optional. If an application adopts them, the same ID belongs in
its URLs, APIs, Capabilities, and other public surfaces. See
[Public resource identifiers](/en/docs/data/public-resource-identifiers) for
the decision and consistency rules.

## Align route declarations

For an API, these values must describe the same public path:

1. `defineApp({ routes })`;
2. the Hono `.route()` mount;
3. the browser client's `baseUrl`;
4. the OpenAPI mount when present.

For a page, align the declared route, Hono page mount, and navigation `href`.

See [Routing](/en/docs/build/routing) for an application example.
