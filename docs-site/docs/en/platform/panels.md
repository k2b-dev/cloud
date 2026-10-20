---
title: Offer a panel
navTitle: Panels
section: Platform services
order: 588
description: Offer an authorized application page beside the current Cloud app.
tags: [panels, applications, layout, ssr]
updated: 2026-10-19
---

# Offer a panel

An application can offer one page in Cloud's panel slot. Signed-in readers can
open it beside the app they are using. Cloud owns the slot, sizing, provider
tabs, loading feedback, and focus return. The application owns the page, its
routes, data, and authorization. Built-in and third-party applications use the
same contract.

Core's Help is the first provider: every signed-in reader has Help in this
slot. It uses the same `panel`, `PanelLayout`, and context APIs as any other
application.

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
startup. `defineApp()` also rejects `panel.href` at or below the app's Help path
`<basePath>/help`, because the framework answers those paths with Help redirects.
`label` and `icon` must be nonempty strings. Translate the label with
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
Ctrl+K, or Cmd+K on Apple devices, inside a provider opens the host page's global
search when that page offers it.
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

With the panel column open, the app area beside it is the app's
`k2b-app-area` host from the server frame. Application chrome tied to the
workspace sidebar or levels follows that host width, as the workspace does:
the app behaves like the same app in a window as wide as its host. Shell focus
hides the workspace navigation only when the host is at least 64 rem; below
that, **Show navigation** still opens its overlay. See
[AppWorkspace: Host width](/en/ui/layout/workspace#host-width).

The column defaults to 26 rem, or 21.5 rem below a 1280 px viewport. Its
separator resizes between 20 and 36 rem. Arrow keys change width by 1 rem,
Shift+Arrow by 4 rem; Home and End select the bounds. A double-click on the
separator returns the column to its default width and forgets the stored width.
Dragging below a raw 16 rem width shows **Release to close the panel**, while
the visible width stays at least 20 rem. Release closes it and keeps the width committed before
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

Readiness must not wait for on-demand code. Render a provider's static content
as server HTML and keep its islands small; load heavy controls when the reader
first reaches for them or when the browser is idle. `PanelRuntime` defers
nothing: the ready mark and message, keyboard forwarding, link routing, theme
sync, the context receiver, and the workspace controller stay eager.

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
ready message also recovers. The timeout covers the loads the slot starts:
opening, retrying, and switching providers.
Pages reached through links inside the panel show as the browser loads them.
Loading and failure surfaces occupy the same box,
so they do not move the app.

## Page context

A page reports its place through `Layout context={{ scope }}`. The v1 context
contains only the place and the page's static Help article IDs:

```ts
type PanelPageContext = {
  v: 1;
  seq: number;       // Nonnegative safe integer, initially 0.
  pageId: string;    // New UUID for each host document.
  app: string;       // Host application ID.
  scope?: { type: string; id: string };
  help?: string[];   // Up to three local Help IDs, filtered by Layout.help.
};
```

It carries no focus, selection, titles, text, credentials, or grants. Later
fields are additive. Help IDs use the same lower-case hyphenated shape as
`Layout.help`, with at most 180 characters each. Resource refs use the shared
[reference contract](/en/docs/platform/resource-references).

Providers served by Core, which need no consent, also receive the page's
conflict-free keyboard shortcuts next to the context: ID, title, optional
description, key combination, and optional scope. Updates arrive live by
message, never in the provider URL, and clear with the context. The list has
at most 24 entries, with length limits on each string. Providers that need
consent never receive shortcuts, including their titles, even after approval.

Only the visible provider receives context, and only from its current tab.
`Layout context={false}` disables sharing for that document, including live
publishers. An invalid scope is omitted. Without a current app or a panel
slot, there is no page context. The slot's cookie stores no context.

### Consent belongs to the shell

Providers served by Core (app ID `core`) are the platform's own surface and
need no consent. Every other provider asks once per provider app. Cloud stores
the answer server-side per person and provider app ID. Unanswered, denied, or
unreadable answers send no context, in either the URL or a message.

Consent controls what the platform delivers to cooperating providers. It is not
an isolation boundary: all applications share one origin and one session, so an
installed application could read another page directly. The operator's decision
to install an application is what protects against a hostile one.

The person chooses **Allow** or **Don't share** in the slot. They can later
change **Share context** in the **⋯** menu, below **Panel from <App>**. A new
answer applies from the moment Cloud has saved it; it does not recall context
already seen.

- **Withdrawing** stops sharing at the click, before the save finishes. It also
  removes the context from the provider's current address, so reloading the
  provider page does not bring it back.
- **Saves are ordered.** Each answer carries a revision, and a save based on an
  older revision is refused. After such a conflict, Cloud reads the current
  answer and saves the person's choice once more. A save that the browser gives
  up on after 10 seconds is rolled back if the server notices the cancellation
  before it commits. A save that still lands later cannot override a newer
  answer, but it applies from the next page load.
- **A failed save** keeps the question open with **Not saved. Try again.**, and
  nothing is shared until the person answers again.
- **Other pages and tabs** that are already open follow the new answer on their
  next page load. A page restored from the browser's back/forward cache stops
  sharing until it has read the answers again.
- Context goes only to the selected provider's page below its panel path; a
  frame that navigated elsewhere receives none. A provider page that the
  browser restores from the panel's own history keeps the context it had
  already seen.

### Read the first context on the server

Cloud puts the first allowed context in the iframe URL's reserved
`cloud_panel_context` parameter. Its value is JSON; `URLSearchParams` handles
percent-encoding. Use the server helper so the first render already knows the
place, for example to render **For this view** without a second frame:

```ts
import { readPanelContext } from "@k2b/cloud/ssr";

const context = readPanelContext(c); // PanelPageContext | null
// Core's Help selects context?.app ?? "core", checks the app's visibility,
// then reads its authorized manifest before selecting any document IDs.
const ids = new Set(manifest.documents.map((document) => document.id));
const view = context?.app === app.id
  ? [...new Set(context.help ?? [])].filter((id) => ids.has(id)).slice(0, 3)
  : [];
```

The helper never throws. It rejects oversized parameters before parsing JSON,
and returns `null` for malformed JSON, extra keys, unsupported versions, or
invalid fields. **URL context is untrusted input:** anyone can craft a URL.
Treat it only as a selector, even when it came from Cloud's slot.

`PanelLayout` embeds the validated snapshot for browser code and sets
`Referrer-Policy: same-origin` on the response, so external links and requests
do not receive the context URL in the Referer header. Keep that policy on
provider responses.

### Follow live changes in the browser

```ts
import { getContext, onContextChange } from "@k2b/cloud/browser/panel";

showPlace(getContext());
const unsubscribe = onContextChange((context) => showPlace(context));
// On disposal:
unsubscribe();
```

The first `getContext()` equals the validated server snapshot. Later calls
return the latest accepted host context or `null`. A provider never needs to
write its own `postMessage` code.

The platform sends `{ type: "cloud.panel.context", v: 1, context }` to
`location.origin`. The embedded receiver accepts only its parent window at
that origin and the exact message schema. Once it knows a `pageId`, it drops
other page IDs and lower `seq` values; equal sequence values are idempotent.
An effective place change increments `seq`, keeping the document's `pageId`.
Switching, closing, or withdrawing sharing sends `context: null` before the
old frame is removed or further sharing stops. Null clears the place while
preserving the receiver's page ID and sequence ordering.

### Refs never grant access

Read a referenced resource through the provider's own server, using the
session's `actor` and `accessSubject`, the capability dispatcher, and the
owning application's declared reader. The slot adds no token, grant, or
permission. Never take identity or access subjects from context or messages.
When the reader has no access, show **No access** without a resource title.

Providers must not implement their own host `postMessage` protocol, store page
context, treat a ref as permission, or forward context to third parties
without the person's action. Gateway and app request logs use paths or route
templates; the context query must stay out of logs, Web Vitals, and error
reports.
