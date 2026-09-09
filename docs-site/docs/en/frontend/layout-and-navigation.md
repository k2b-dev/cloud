---
title: Layout and navigation
navTitle: Layout and navigation
section: Frontend
order: 820
description: Place application pages in the shared Cloud layout and navigation.
tags: [layout, navigation, breadcrumbs]
updated: 2026-08-30
---

# Layout and navigation

Wrap a Cloud application page in `Layout`, `AdminLayout`, or `MinimalLayout`.

The shared layout provides the header, breadcrumbs, app navigation, mobile
navigation, global search, profile preferences, and footer.

Layout owns Cloud chrome; an [application shell](/en/docs/frontend/application-shells)
owns the geometry inside it.

## Render the application layout

```tsx
<Layout
  c={c}
  title={[
    { title: "Inventory", href: "/app/inventory" },
    { title: item.name },
  ]}
>
  <ItemDetail item={item} />
</Layout>
```

The final breadcrumb has no link. A plain string is valid for a one-level
title.

Use `fullWidth` for a multi-column workspace. Use `fullPage` for a fill-height
surface without the footer.

Do not reproduce Cloud chrome inside application content.

## Render anonymous application pages

`Layout` uses the same application shell for authenticated and anonymous
requests. Anonymous pages keep the header visible at every viewport width,
show a direct sign-in action, and expose the shared language and theme menu.
They do not render the authenticated application rail, app launcher, global
search, notifications, or profile actions.

Use this default for public pages that should still look and navigate like a
Cloud application, such as a utility catalog or public FAQ. The presence of
`Layout` does not authorize the route or its data. Follow
[Public and anonymous access](/en/docs/identity/public-and-anonymous-access)
for route and resource policy.

## Keep an app-owned public surface minimal

Use `MinimalLayout` when a standalone page should keep its application-owned
background, spacing, branding, and content geometry without Cloud header,
rail, footer, or canvas styling:

```tsx
import { MinimalLayout } from "@k2b/cloud/ssr";

return () => (
  <MinimalLayout c={c} preferences="bottom-right">
    <PublicDocument document={document} />
  </MinimalLayout>
);
```

`MinimalLayout` installs the request locale, persisted theme, and browser
timezone wiring expected by Cloud and `@k2b/ui`. Its only visible element is a
language and theme menu. `preferences` accepts `top-left`, `top-right`,
`bottom-left`, or `bottom-right`; it defaults to `bottom-right`. Set it to
`false` for embeds or fixed presentation surfaces that must have no control.

The layout adds no wrapper around application content. The application remains
responsible for its one semantic `main` landmark and all page styling. Do not
use `MinimalLayout` as an access-control signal: route middleware, public
grants, and share-token validation remain separate server responsibilities.

## Use the responsive profile menu

Authenticated users change the theme or language from the profile control and
can open `/me` for the remaining profile settings. Anonymous `Layout` pages
and opted-in `MinimalLayout` pages expose the same preferences without profile
actions. Applications must not add a second theme or language control to their
own content.

The shared layout chooses the placement with CSS:

- On mobile, clicking the profile avatar opens the menu in the header;
- On desktop viewports up to `1536px` wide, the header and breadcrumbs are
  removed and the profile avatar moves to the bottom of the app rail;
- On wider desktop viewports, the profile avatar stays in the header.

On pointer devices, clicking the avatar opens `/me`; hovering or focusing it
opens the adjacent preference menu. Touch and coarse-pointer devices use the
clickable dropdown.

## Register navigation

Application navigation comes from `defineApp()`:

```ts
nav: {
  href: "/app/inventory",
  match: "/app/inventory",
  section: "primary",
  requiresAuth: true,
  requiresRoles: ["user"],
}
```

`section` is `primary`, `more`, or `hidden`. The layout filters entries with
the current request identity.

The live app registry supplies the navigation. Do not hardcode links to every
other Cloud application.

## Personalize the app bar

The desktop app bar sorts ordinary apps alphabetically using the current UI
language. An application's `nav.section` supplies the default: `primary` is
shown, `more` stays in the launcher, and `hidden` is never offered. Users can
open **Apps → Customize app bar** from any application, including the
dashboard, to show or hide individual available apps. The subtle settings icon
at the top right of the launcher opens the editor. Newly installed apps follow
their declared defaults.

App bar shortcuts form a separate, ordered list above the ordinary apps, with
a divider between the two groups. Users can pin an app or add a link with a
title and icon, edit it, move it up or down, or remove it. Pinning an app removes
its duplicate from the ordinary list. Links to individual pages can coexist
with their application. Dashboard shortcuts remain independent.

The editor groups apps and shortcuts into separate sections. Its fixed footer
places **Reset app bar** on the left and **Save** on the right.

**Save** applies the changes across Cloud. Closing with unsaved edits asks before discarding them;
**Reset app bar** prepares the default app selection and an empty shortcut list
for saving. If another editor has saved in the meantime, the save is rejected
so that those changes are not overwritten. Close and reopen to load them.

App and shortcut hints open immediately to the right on hover or keyboard
focus. The app list scrolls when space is limited, keeping the launcher and
global controls reachable. On mobile, app bar shortcuts remain available in
the app launcher.

Core stores these preferences per user; the platform loads them before SSR
without a process-wide preference cache. Applications do not need to fetch or
persist navigation settings themselves. Apply the Core migration before
starting applications built against this layout. Unavailable apps are omitted without
removing their saved preferences. Showing or pinning an app does not grant
access to its routes or resources.

The self-service API is `GET /api/me/rail` and `PUT /api/me/rail`. The snapshot
contains `revision`, `visibility` (app IDs mapped to booleans), and `shortcuts`.
Writes must supply the revision read previously; a stale revision returns
`409`. Core derives the user from authentication. Settings have a 16 KiB
serialized page budget; links accept absolute paths and HTTP(S) URLs without
embedded credentials. App shortcuts resolve metadata from the current,
authorized registry.

## Render an admin page

```tsx
<AdminLayout c={c} title="Inventory">
  <h1 class="text-base font-semibold text-primary">
    Inventory
  </h1>
  <InventoryAdminPanel />
</AdminLayout>
```

`AdminLayout.title` sets breadcrumbs. The page renders its own heading.
The admin shell stays within the viewport, with independent sidebar and content
scrolling. For a bounded child such as `SettingsPage`, pass `scroll={false}` to
`AdminLayout`: the child then owns content scrolling and its fixed save footer.
The default remains `scroll={true}` for ordinary admin pages.

App-owned admin groups come from `adminNav` in the application declaration.

## Use anchors for navigation

Navigation controls start as anchors with an `href`. A link must work before
hydration and support open-in-new-tab.

Use enhanced navigation only inside an island that also updates its own state.
See [URL state and navigation](/en/docs/frontend/url-state-and-navigation).
