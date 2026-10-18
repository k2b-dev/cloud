---
title: Offer a panel
navTitle: Panels
section: Platform services
order: 588
description: Offer an authorized application page beside the current Cloud app.
tags: [panels, applications, layout, ssr]
updated: 2026-10-18
---

# Offer a panel

An application can offer one page in Cloud's panel slot. Signed-in readers can
open it beside the app they are using. Cloud owns the slot, sizing, provider
tabs, loading feedback, and focus return. The application owns the page, its
routes, data, and authorization. Built-in and third-party applications use the
same contract.

## Declare and serve the page

Declare one `panel` in `defineApp()`:

```ts
import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Track stock",
  baseUrl: "http://inventory:3000",
  routes: ["/app/inventory", "/api/inventory"],
  panel: {
    href: "/app/inventory/panel",
    label: "Stock lookup",
    icon: "ti ti-box",
    requiresRoles: ["user"],
  },
});
```

`href` must be a same-origin path below an application-owned route. External
URLs, protocol-relative URLs, and paths that escape the route are rejected at
startup. `label` and `icon` must be nonempty strings. Translate the label with
`presentation.translations[locale].panelLabel`; the label defaults to the
application's base locale. Cloud sorts visible providers by localized label,
then application ID. No provider gets priority.

Serve a GET page at the declared path with the normal identity, runtime, and
permission middleware. Inside the application's SSR handler, render:

```tsx
import { PanelLayout } from "@k2b/cloud/ssr";

<PanelLayout c={c} title="Stock lookup">
  <StockLookup />
</PanelLayout>
```

`PanelLayout` sets the page title and request locale and renders a viewport-height
flex column with the reader's theme. It includes the provider runtime, without
Cloud's rail, header, footer, banners, or another panel slot. Use it for the
provider page instead of nesting `Layout` inside the iframe. Keep same-origin
embedding allowed; see [Build and deploy](/en/docs/operations/build-and-deploy#enable-panel-providers).
The embedded provider page follows the host's light or dark theme live, without
reloading. `AppWorkspace` works inside `PanelLayout` as in `Layout`; its sidebar
and detail sizes are not saved for the panel page.

Links stay in the panel only below the declared panel path. A same-origin link
outside it opens in the app window, so the panel never shows a second Cloud
shell. Links with a `target`, a `download` attribute, or modifier keys keep
their browser behavior, and a click handler that calls `preventDefault()` wins.
Navigation by script or form submission is the provider's own: keep it below
the panel path.

`requiresRoles` filters visibility only, using the same role rules as app
navigation. **The slot grants nothing.** The provider route, APIs, and services
must still authorize every request. Anonymous pages have no slot, and an
application can hide it on a particular page with `Layout panel={false}`.

## Open, switch, and close

From application browser code:

```ts
import { closePanel, openPanel } from "@k2b/cloud/browser/panel";

const accepted = openPanel("inventory", { search: "q=bolts" });
if (!accepted) window.location.assign("/app/inventory");

// In an action that closes the current panel:
closePanel();
```

`openPanel` returns `false` without changing the page when there is no slot or
the provider is not visible. Keep the caller's ordinary navigation in that
case. An accepted request loads the controller on demand, parks any open
workspace detail drawer, and moves focus into the panel. `search` replaces the
provider URL's query; a leading `?` is optional. A request with `search` loads
that address even when the reader has moved to another page inside the panel. Values other than strings and
strings longer than 2048 characters are ignored. Search is never stored in the
panel cookie.
Inside a provider page, `openPanel()` returns `false` because that page has no
slot.

With multiple providers, Cloud shows tabs and a Panel button in the rail and
phone header. A single provider has a title instead of tabs; use its app action
or the shortcut to open it. Tab arrows and Home/End move focus; click, Enter,
or Space activates a provider. Switching unloads the old iframe, leaving only
one provider loaded.

Ctrl+J, or Cmd+J on Apple devices, opens or closes the panel. It also closes the
panel from inside a provider. Escape closes it when focus is inside the slot or
provider. A provider's menu, dialog, or search field can keep Escape by calling
`preventDefault()`; the provider runtime checks after event dispatch finishes.
While a modal dialog is open in the provider page, Escape belongs to that
dialog and never closes the panel.
The close button also closes it. `closePanel()` works both in the host app and
inside the provider page. Focus returns to the opener, or to the app's main area
if the opener is gone or hidden. Opening a workspace Detail does not close the
panel.

## Size and persistence

| Viewport width | Panel form | Effect on the app |
| --- | --- | --- |
| From 1024 px | Right column | Narrows the app area and its workspace host |
| 768–1023 px | Non-modal right drawer | Overlays the app without changing its width |
| Below 768 px | Bottom sheet | Overlays the app; the grabber toggles full height |

The column defaults to 26 rem, or 21.5 rem below a 1280 px viewport. Its
separator resizes between 20 and 36 rem. Arrow keys change width by 1 rem,
Shift+Arrow by 4 rem; Home and End select the bounds. Dragging below a raw
16 rem width shows **Release to close the panel**, while the visible width
stays at least 20 rem. Release closes it and keeps the width committed before
that drag. Moving back above the threshold cancels the close intent.

From 768 px, `cloud_panel` remembers only open state, provider ID, and optional
width in rem for one year (`Path=/`, `SameSite=Lax`, `Secure` on HTTPS).
It stores no URL, search, or page context. The server reads it to draw the open
slot and app width in the first frame; starting the runtime must not shift the
layout. Drawer and column share this persisted open flag. Printing hides the
slot.

Focus pages (`Layout focusMode`, such as pop-out editors) start with the panel
closed and never write the cookie, so a pop-out window does not change the
panel of the main window. Ctrl+J or Cmd+J opens the panel there.

The phone sheet has a separate, transient flag. Below 768 px the controller
never writes the panel cookie. A new document always starts with it closed.
Back and Forward between app pages, a restored page, and an in-page navigation
of the app that adds a history entry close the sheet; the last needs a browser
with the Navigation API. History entries of the provider page stay with the
panel: Back after a navigation inside the panel shows the panel's previous page. Replacing the URL for page state keeps the sheet open. While the sheet is
open, a regular page can scroll its last row above it.

## Loading and message boundaries

`PanelLayout` posts `{ type: "cloud.panel.ready", v: 1, provider: appId }` to the
parent with `location.origin` as the target origin, and marks its own document
as ready. When the server rendered the slot open, the provider can be ready
before Cloud's panel code has loaded; Cloud then reads that mark from the
same-origin iframe instead of loading the provider again. Its close shortcut posts
`{ type: "cloud.panel.close" }`. Cloud accepts messages only from the current
iframe window at the host's origin. Ready requires exactly `type`, `v: 1`, and
the active provider ID. Close accepts exactly `type`, with an optional `v: 1`.
Arrays, extra fields, unknown providers, and other versions are rejected.

Without ready within 10 seconds, the slot shows **The panel did not load** and
**Try again**. Retry replaces the iframe and starts a new timeout. A late valid
ready message also recovers. Loading and failure surfaces occupy the same box,
so they do not move the app.

## Page context

Page context arrives in a later release. This contract does not send context
to providers. Resource references never grant access; a provider must authorize
the referenced resources when context becomes available.
