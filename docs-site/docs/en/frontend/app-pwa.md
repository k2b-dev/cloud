---
title: Install an application as a PWA
navTitle: App-PWA
section: Frontend
order: 836
description: Give one application its own installation, neutral start path, generated icons, and offline fallback.
tags: [pwa, installation, offline, routing]
updated: 2026-10-23
---

# Install an application as a PWA

Declare `installable` when people need to open one application from their Home
Screen in a standalone window. Each application can declare one installation;
several applications can be installed from the same Cloud origin.

This is separate from the Cloud mobile app's [`pwa` parts](/en/docs/frontend/mobile-app-pages).
The declaration adds no account session, device pairing, or customer-session
permissions. Authorize application pages and APIs through the normal server
contracts. For a shared customer device, add [device pairing and visit sessions](/en/docs/identity/app-pwa-sessions).

## Declare the installation

```ts
import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-packages",
  description: "Track stock and warehouse movements.",
  baseUrl: "http://app-inventory:3000",
  basePath: "/app/inventory",
  routes: ["/app/inventory", "/api/inventory", "/public/inventory"],
  installable: {
    path: "/app/inventory/counter/",
    name: "Inventory counter",
    shortName: "Counter",
    icon: "ti ti-pencil",
    themeColor: { light: "#fafafa", dark: "#090d12" },
    display: "standalone",
  },
});
```

`name` and `shortName` must be nonempty. `icon` names an existing outline Tabler
icon in the form `ti ti-pencil`; an unknown icon fails the build. Both theme
colors are six-digit hex values. `display` is `"standalone"`.

`path` is the installation identity, start URL, and scope. Keep it stable:
changing it creates a different installation. It must end in `/`, start with
`/app/<this-app-id>/`, and contain at least one surface segment after the app
id. Surface segments use lowercase letters, digits, and hyphens. Encoding,
backslashes, dot segments, queries, fragments, duplicate slashes, and framework
paths such as `help`, `_ssr`, and `_internal` are rejected.

A declared route at or below `/app/<id>` must cover the start path. `/` or
`/app` alone does not count, and Cloud does not invent route coverage. Mount the
matching Hono page routes as described in [Routes and discovery](/en/docs/build/routing).
Invalid declarations fail at `defineApp()` and are rejected by registry readers.

## Render the neutral start page

Serve a neutral page at `installable.path`: show the application name and the
next available action without restoring private customer content from browser
storage. Use `app.ssr()` for this page and other pages inside its scope. A
standalone application can compose [`MinimalLayout`](/en/docs/frontend/layout-and-navigation)
without the Cloud navigation shell.

Cloud recognizes the actual request path and automatically adds the manifest,
Apple Home Screen icon and title, theme color, safe-area padding, service-worker
registration, and installation hint. No layout hook or per-page opt-in is
required. The same integration applies to `app.ssr.error()` documents inside
the scope. Pages outside it retain their normal document head.

Use the standard [build and development scripts](/en/docs/operations/build-and-deploy).
They generate light and dark PNG icons at 192 and 512 pixels, an opaque 512-pixel
maskable icon with its artwork inside the safe circle, and a 180-pixel Apple
icon. Theme changes update the manifest link, Apple icon, and browser theme
color without changing the installation identity.

## Install and open the app

Use HTTPS, or localhost for development. In Chromium, Cloud shows **Install
app** when the browser supplies an installation prompt. The browser decides
whether installation is available; opening the prompt does not confirm an
installation.

On iOS and iPadOS, the hint explains how to open Safari's Share menu, choose
**Add to Home Screen**, and confirm **Add**. It also recognizes iPads that
request desktop websites. The hint follows the request locale in English or
German and disappears in standalone mode. If worker registration fails, the
page offers **Try again** and remains usable online.

Installation does not create a separate security origin. Scripts on the same
origin share a trust boundary. For a shared customer-facing device, use a
separate browser profile without an employee sign-in.

## Predict offline and update behavior

The generated worker uses the network for scoped `GET` navigations. When the
network fails, it returns one neutral bilingual offline document with **Try
again / Erneut versuchen**. Retrying reloads the current address. It never
stores application pages, API responses, documents, secrets, or signatures.
The offline document is embedded in the worker; no Cache Storage is created.
API requests, other subresources, `POST` requests, and other applications pass
through to the network.

A worker update waits while a window controlled by the old worker remains
open. Close all windows of that installation, then reopen it to activate the
update. Cloud sends no activation message, claims no existing windows, and
forces no reload. Other installed applications can stay open.

## Framework-owned public paths

Cloud serves these paths before application access and authentication
middleware. They contain only public installation metadata or generated assets:

| Path relative to `installable.path` | Response |
| --- | --- |
| `manifest.webmanifest` | Manifest; `?theme=light` or `?theme=dark` selects presentation, with light as the default |
| `sw.js` | Worker limited to the declared scope |
| `offline.html` | The same neutral bilingual fallback document |
| `icon-192-<theme>.png`, `icon-512-<theme>.png` | Launcher icons |
| `icon-maskable-512-<theme>.png` | Opaque maskable icon |
| `apple-touch-icon-<theme>.png` | Apple Home Screen icon |

Here `<theme>` is `light` or `dark`. The routes support `GET` and `HEAD`;
unsupported methods return `405`. A missing generated icon returns `404` rather
than reaching application code. Opening the bare start path without its final
slash redirects to the canonical path.

Do not serve your own worker in this namespace. The gateway permits only the
exact generated `sw.js` as a worker script and strips scope-broadening headers.
It rejects foreign claims anywhere below `/app/<id>` and prevents a root or
ancestor route from answering for another app, including when the owner has no
valid registry entry. See the [runtime deployment note](/en/docs/operations/build-and-deploy#deploy-app-pwa-support).
