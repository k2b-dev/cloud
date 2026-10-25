---
title: Pages in the mobile app
navTitle: Mobile app pages
section: Frontend
order: 835
description: Add phone-first pages of an application to the installable mobile app.
tags: [mobile, pwa, routing, layout]
updated: 2026-10-23
---

# Pages in the mobile app

> **Preview:** the mobile app is not released yet. This contract may still
> change until it is, without counting as a breaking change.

Each Cloud installation has one installable phone app. The `pwa` application
provides it: the Home Screen app, its Start page, Settings, and pairing. An
application adds a **part**: its own pages at `/pwa/<app-id>`, built for a
task people do on a phone. A part is not the web version on a small screen.
It looks and behaves like an app and offers only what the phone task needs.

The mobile app finds parts in the live app registry. People install nothing
per application, and applications without a part do not appear in the app.
Built-in and third-party applications use the same contract.

## Declare a part

Add `pwa` to `defineApp()`:

```ts
export const app = defineApp({
  id: "inventory",
  // required fields
  routes: ["/api/inventory", "/app/inventory", "/public/inventory"],
  basePath: "/app/inventory",
  pwa: { requiresRoles: ["user"] },
});
```

Cloud then:

- adds `/pwa/inventory` to the application's routes;
- publishes the part in the registry entry;
- lists the application on Start and, among the first three parts, in the tab
  bar, with its `name`, `icon`, and `description` in the reader's language.

`requiresRoles` only controls visibility in the app, like
`nav.requiresRoles`. Routes and services still authorize every request. Without
it, every signed-in person sees the part. The app has no `admin` role, so a part
limited to administrators never appears.

Do not list `/pwa` paths in `routes`; `defineApp()` throws for them. See
[Define an application](/en/docs/build/define-app#add-pages-to-the-mobile-app).

Spaces adds its "My tasks" page this way, as an example of a list with a quick
action; see [Spaces](/en/apps/spaces#check-off-tasks-in-the-mobile-app).

## Paths

| Path | Owner |
| --- | --- |
| `/pwa/` | The mobile app: Start, the manifest scope |
| `/pwa/settings`, `/pwa/offline` | The mobile app |
| `/pwa/_auth/*` | Core: the phone's sign-in endpoints |
| `/pwa/<app-id>/*` | The application's part |
| `/api/<app-id>/*` | The application's API, used by the part as on the web |

Only paths below `/pwa/` count as inside the app. iOS and Android open any
other address of the installation in a browser view without the app's session.

A part's application id consists of lowercase letters, digits, and hyphens and
starts with a letter. The ids `pwa`, `settings`, and `offline` cannot declare a
part. The gateway skips every other route below `/pwa`, also from applications
that do not use `defineApp()`. See
[Route conventions](/en/docs/reference/route-conventions#mobile-app-paths).

## Serve pages

Mount the part's pages at `/pwa/<app-id>`. Protect each page with
`ssr.pwaAccess` and render it in `PwaLayout`:

```ts
// src/index.ts
const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/inventory", api)
  .route("/pwa/inventory", pwaPages);

// src/pwa/index.ts
export const pwaPages = new Hono<AuthContext>().get(
  "/",
  auth.requireRole("authenticated", ssr.pwaAccess),
  auth.requireUser(ssr.pwaAccess),
  ...listPage,
);
```

```tsx
// src/pwa/list.page.tsx
import { PwaLayout } from "@k2b/cloud/ssr";

export default ssr<AuthContext>(async (c) => {
  const items = await inventory.listForPhone(c.get("accessSubject"));
  return () => (
    <PwaLayout c={c} title={t(c).title}>
      <ItemList initial={items} />
    </PwaLayout>
  );
});
```

`ssr.pwaAccess` handles a rejected request:

| Case | Response |
| --- | --- |
| No app session | `302` to `/pwa/_auth/session/launch?to=<path and query>`; Core renews the session and returns the phone to the same page |
| No app session after that return (`pwa_launch` in the query) | `302` to `/pwa/?pwa=unavailable`, which stops a redirect loop |
| Signed in without the required role | `403` page in the mobile app's layout |

Each of these responses sets `Cache-Control: private, no-store`. For other errors, call
`ssr.error(c, status, { layout: "pwa" })`; see
[SSR pages and routing](/en/docs/frontend/ssr-pages-and-routing).

Every part needs a `basePath`, because `PwaLayout` renders islands of its own.
Without one, the island scripts load from `/_ssr`, which belongs to Core, and
the layout's browser behavior never starts. Use a prefix the application owns,
such as `/app/inventory`, or `/pwa/inventory` when the application has no web
pages. Declare `/public/<app-id>` when the part has its own styles.

### PwaLayout

`PwaLayout` from `@k2b/cloud/ssr` frames every page in the mobile app:

| Prop | Meaning |
| --- | --- |
| `c` | The request context |
| `title` | Header heading and document title |
| `sidebarTitle` | Optional heading beside the sidebar, where the sidebar already names the installation; `title` by default |
| `back` | Optional `{ href, label, withSidebar }` for going up inside the part, for example from a detail to its list; `withSidebar: false` hides it beside the sidebar |
| `actions` | At most two icon buttons at the end of the header |
| `bare` | The page brings its own heads and scroll areas, such as `AppWorkspace.Main` levels; `title` still names the document |
| `children` | The page content, in the app's only scroll area |

It renders the app's document head, a
[`MobileShell`](/en/ui/layout/mobile-shell) with a header, a
[`TabBar`](/en/ui/layout/tab-bar) with Start and the first three parts, and a
sidebar with Start, every part, and Settings for wide screens. Start
lists every part, so it also serves as "More", and opens Settings from its
header. The layout provides the request locale, follows the person's Light,
Dark, or Automatic theme preference, and sets `Referrer-Policy: no-referrer`
and `frame-ancestors 'none'`. In the browser, it registers the app's service
worker, shows an offline notice, and keeps the app session alive. With
Automatic, the status bar color follows the device's appearance.

In Settings, the appearance button shows the current choice. Each tap switches
from **Automatic** to **Light**, then **Dark**, then **Automatic** again.
Automatic is the default and follows the device.

App pages switch at once, without the cross-fade that web pages use between
documents. A browser ignores taps while such a transition runs, so a quick
second tap in the tab bar would be lost.

A tab or sidebar row switches at the first touch. The item shows as selected, the header
shows the title of the tab's page, and the content area is empty. The page
loads at the end of the tap, as with any link, so the browser's Back still
returns to the page where the tab was tapped. A repeat tap does not start the
load over. The header shows Start with the installation's name and a part
with its `name`, so title the part's first page with the application's name,
as Spaces does. Otherwise the title changes when the page arrives.

### iPad and monitor

The same pages serve every width; the window width decides, not the device, so
Split View and Stage Manager follow the same rules:

| Window width | Navigation | A list and its detail |
| --- | --- | --- |
| Below 48 rem (768 px): phone, iPad in narrow Split View | Tab bar at the bottom | One after the other; the detail is a page of its own with Back |
| 48 to 64 rem: iPad upright, wide Split View | Sidebar, 15 rem | One column; the detail is a page of its own with Back |
| From 64 rem (1024 px): iPad across, monitor | Sidebar, 15 rem | Side by side: the list 22 rem, the detail in the rest |

There is no further step for large monitors. Surfaces run to the window's
edge, and columns keep their limits instead, such as 44 rem for a detail.
Rotating changes only CSS: the address, the selection, typed text, focus, and
the scroll position stay.

For a list with details, give the detail an address of its own below the
part, render both on one page with
[`AppWorkspace.Main` levels](/en/ui/layout/workspace#levels) in
`PwaLayout bare`, and keep the selection in the address. A reload, Back, and
rotating then show the same selection. Spaces does this for one task at
`/pwa/spaces/<space>/<task>`.

On a wide screen, a page whose title the sidebar's head already says passes
`sidebarTitle`, as Start does. Keep the touch rules at every width: an iPad is
a touch device, also with a trackpad.

### Only the app's session reaches a part

Requests below `/pwa/`, except Core's `/pwa/_auth`, authenticate only with the
mobile app's session, whatever the request type. A web session or an API key
never reaches part content, so `auth.requireRole` on a part route already
admits only the app. Parts need no extra middleware. See
[Which session a request uses](/en/docs/identity/authentication#which-session-a-request-uses).

An app session resolves to the same `actor`, `accessSubject`, and
`credentialKind: "session"` as a web session of the same person. It also
carries `sessionKind: "app"`. Use `actor` for audit and `accessSubject` for
grants, as on the web.

## Restart at the last page

Launching the Cloud-App from the Home Screen resumes its last successful page,
including its path and query below `/pwa/`. Tapping Start still opens Start.
Signing out of the app or completing a new pairing resets the destination to
Start. If access to the remembered page has changed, that page shows its own
403 or 404.

The shell handles this for every part. It remembers the address in the
`pwa_last_address` cookie: `Path=/pwa/`, `Secure`, `SameSite=Lax`,
with the pairing's 150-day idle lifetime. Each successful page writes its
address when it arrives and again when the app leaves the foreground, so
changes a part makes through browser history count too, as Spaces makes for
task selections and filters. A page that is being left writes nothing, so it
never replaces the next page's address or undoes a sign-out. It stores no
credentials, fragments,
auth endpoints, welcome states, or error pages. Without an app session, the
launch bounce renews the session and validates the remembered destination.

The manifest uses `/pwa/?launch` to distinguish a Home Screen launch from a
Start link before rendering a page. Its existing `id: "/pwa/"` stays unchanged.
Already installed apps need their browser to adopt the updated manifest. A
browser that retains the old `/pwa/` start URL still opens Start while its app
session is valid; without a session, it resumes through the launch bounce.
Reinstalling adopts the new start URL when the browser does not update it.

## Keep drafts

Parts keep unsaved text with `pwaDrafts` from
`@k2b/cloud/browser/pwa-drafts`. Key each field by the signed-in account's id
and a stable field id, including the conversation or resource id when needed.
Store only the text the person typed: no credentials, attachments, account
objects, or server data.

```ts
import { pwaDrafts } from "@k2b/cloud/browser/pwa-drafts";

// Restore after mounting, so SSR and the first browser render agree.
const draft = pwaDrafts.read(accountId, "chat.composer:conversation-id");
// On every input, including empty text:
const kept = pwaDrafts.write(accountId, "chat.composer:conversation-id", text);
// After a successful send/save, or an explicit discard:
pwaDrafts.remove(accountId, "chat.composer:conversation-id");
```

An absent draft returns `undefined`; an empty draft returns `""`. Draft values
are plain text in `localStorage` and survive the app being ended or reloaded.
If `write` returns `false`, explain that this browser cannot keep the draft
after the app closes. The helper protects the current document's text from
automatic update reloads even then. Keep a failed save's draft and preserve any
new text typed while a save or send was in flight.

The shell uses this contract for the device name in Settings. The platform
clears every account's app drafts on sign-out, a new pairing, or a server
response that says the device was removed. Other browser storage is untouched.
Parts do not need their own sign-out cleanup.

## Rules for parts

- Serve pages only below `/pwa/<app-id>`, each in `PwaLayout` with
  `ssr.pwaAccess`. Check resource permissions in services, as on the web.
- Keep APIs at `/api/<app-id>` and call them through the typed browser
  client from `api.create()`. On an app page it renews an ended app session
  and repeats the request once, so a `401` that still reaches the part is
  final, for example while offline. Treat it like any failed request; do not
  reload the page. See
  [Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations#create-a-typed-client).

- WebSocket and stream handlers take the credential from the auth middleware
  or from `await auth.session.resolveToken(c)`, never from a cookie by name.
- Link only inside `/pwa/`. `tel:`, `mailto:`, and external `https:` links are
  fine. Links to `/app/…`, `/me`, or `/admin` leave the app: iOS opens a
  browser sheet without the app's session.
- Navigations outside `/pwa/` never carry the app's session. Fetch a download
  and save it as a file, or serve it through a route below `/pwa/<app-id>`.
- The app has no administration. App sessions never carry the `admin` role,
  and sign-in methods, API keys, background mandates, OAuth grants, and push
  endpoints need the web. Guard routes that create such authority with
  `auth.rejectAppSession`; see
  [App sessions](/en/docs/identity/authentication#app-sessions-preview).
- Do not register a service worker, set `theme-color`, or add `position: fixed`
  or `sticky` layers at the top edge. The layout owns all three; iOS takes the
  status bar color from the top layer. The gateway answers `403` to a worker
  script request below `/pwa` that does not go to the mobile app.
- The server renders the initial data and decides permissions. Islands handle
  only the interaction. Views and filters live in the URL.
- Design for the phone: one column, flat sections without boxes inside boxes
  and without lines between rows or sections, one primary action per screen,
  targets of at least 44 px, nothing that needs hover, public `@k2b/ui`
  components, light and dark, and every language the application supports.
  Use the shell's type scale; see its
  [touch rules](/en/ui/layout/mobile-shell).

## Touch gestures

The mobile app feels like an app, as Cloud Login does. Pinch zoom is off,
including in dialogs, and touch scrolling stays available. The page itself
never scrolls or bounces: the header and the tab bar stay in place, and only
the content scrolls. Text fields use 16 px text, so iOS does not zoom into a
focused field.

`PwaLayout` applies these rules through `MobileShell`; see its
[touch rules](/en/ui/layout/mobile-shell). They apply only to pages in the app,
never to the web. Because nobody can zoom, keep regular text sizes, let text
wrap, and never rely on zoom to make content readable. A control that needs its
own gesture, such as a drag handle, sets its own `touch-action`.

## Offline and updates

The mobile app's service worker handles only navigations below `/pwa/` and
caches nothing. Every page and every API response comes from the network.
When the installation cannot be reached or the gateway cannot reach the
application, the app shows its offline page with **Try again**. While a part's
application is not registered, its pages show the app's not-found page. An
open page shows a "You're offline" notice above the tab bar until the
connection returns.

Parts have no offline mode of their own. Write actions need the network: keep
the action available, report a failure in a toast with **Retry**, and never
leave an unsaved change looking saved. A quick, reversible action, such as
checking off a task, may show its result at once with **Undo**. Send the changes
to one item one after another, so the person's last choice is the one that
stays. When the server refuses a change or cannot be reached, show the state
the server kept and say why.
Controls that the server renders before their island runs stay disabled until
then, because a tap on them would do nothing.

### Pick up updates

Each tab tap and link loads a fresh document from the network. An open app
also checks release identities through its existing session keepalive, on
returning from the background and hourly while visible. It compares the
page owner's build and Core's shared-asset build with those used to render
the document; an unrelated part's release does not make this page stale.
Unnamed development builds do not identify a release.

On returning to the foreground with a new version, the app reloads the current
address when no field the person types into (text, numbers, dates, and times)
is focused, no unsaved typing or account draft remains, and no modal dialog is
open. Otherwise it shows a persistent quiet notice with the installation's
name, such as **New version of Example Cloud · Reload** (**Neue Version von
Example Cloud · Neu laden** in German), in the work area's toast rail. Its action reloads the current page; stored drafts
restore after mounting. The hourly check offers the same notice and never
interrupts work with an automatic reload. There is no extra polling.

Parts use the draft helper for text they intend to save or send. For other
text fields, automatic reloads also defer when input differs from the field's
`defaultValue`; update that baseline after successfully saving. A field with
focus always holds an automatic reload, even before the first keystroke.

When the mobile app is not running, a request to a part still reaches the part,
but without an app session it ends at Core's not-found page. Nobody can pair a
phone then.

## Test a part

Cover the part at its own seams, as described in
[Frontend testing](/en/docs/frontend/testing):

- **Route:** a request with only a web session or an API key redirects to
  `/pwa/_auth/session/launch`; with an app session the page renders; without
  the required role it answers `403`.
- **Render:** the page in `PwaLayout` with its views, empty states, and the
  data the person may see.
- **Behavior:** at a phone width of 390 px in light and dark, every action
  works by touch, and a failed write offers **Retry** and shows the state the
  server kept.
- **Safari:** run the behavior checks in WebKit with iPhone emulation, because
  iOS decides the status bar color and the zoom behavior.

To try a part on a phone, run Cloud over HTTPS at the address set in the
installation's URL setting, open `/me/app` on a computer, and pair the phone.

## Speed budget

The mobile app must feel like an app on a phone, also over a slow link such
as a VPN. Every part keeps these limits:

| Interaction | Budget |
| --- | --- |
| Press feedback on a tab, link, or button | Within one frame, and at most 100 ms after the finger touches |
| A settings choice, such as language or appearance | Visible as selected within 100 ms |
| A tab switch inside one application | No full page load; visible response within 100 ms |
| A page opened for the first time | One document round trip plus server rendering |

Switches between applications, such as Start → Spaces, still load a new
document because each application has its own asset bundle.

A write that the person can undo, such as checking off a task, shows its
result at once and saves in the background, as described in
[Offline and updates](#offline-and-updates).

### Judge loading speed

Judge loading speed on a production build. In production, the phone's
browser keeps stylesheets, scripts, and fonts in its cache, so a tab switch
usually loads only its page. After an application restarts or updates, its
first page loads its stylesheets again. A development stack serves the same
files uncompressed and asks the server again for each of them on every
page. Over a slow or remote connection, such as a VPN, a tab switch then takes
a second or more, while the same switch in production takes a few hundred
milliseconds.

Measure the budget with the performance harness. It pairs a throwaway phone
through the real pairing flow and times taps, tab switches, settings changes,
check-off, back and forward, and relaunches in WebKit at iPhone and iPad sizes
and in Chromium at phone and monitor sizes, with the HTTP cache state of
every asset:

```bash
bun --no-env-file scripts/perf-baseline.ts --pages pwa
```

Add `--rtt 100` to stand in for a VPN. See
[Measure the installable Cloud app](/en/docs/contributing/performance-baseline#measure-the-installable-cloud-app).
