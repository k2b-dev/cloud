---
title: Pages in the mobile app
navTitle: Mobile app pages
section: Frontend
order: 835
description: Add phone-first pages of an application to the installable mobile app.
tags: [mobile, pwa, routing, layout]
updated: 2026-10-05
---

# Pages in the mobile app

> **Preview:** the mobile app is not released yet. This contract may still
> change in a minor release.

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
| `back` | Optional `{ href, label }` for going up inside the part, for example from a detail to its list |
| `actions` | At most two icon buttons at the end of the header |
| `children` | The page content, in the app's only scroll area |

It renders the app's document head, a
[`MobileShell`](/en/ui/layout/mobile-shell) with a header, and a
[`TabBar`](/en/ui/layout/tab-bar) with Start and the first three parts. Start
lists every part, so it also serves as "More", and opens Settings from its
header. The layout
provides the request locale, follows the person's light or dark theme, and
sets `Referrer-Policy: no-referrer` and `frame-ancestors 'none'`. In the
browser, it registers the app's service worker, shows an offline notice, and
keeps the app session alive.

App pages switch at once, without the cross-fade that web pages use between
documents. A browser ignores taps while such a transition runs, so a quick
second tap in the tab bar would be lost.

A tab switches at the first touch. The tab shows as selected, the header
shows the title of the tab's page, the content area is empty, and the page
load starts before the finger lifts. A repeat tap does not start the load
over. The header shows Start with the installation's name and a part with its
`name`, so title the part's first page with the application's name, as
Spaces does. Otherwise the title changes when the page arrives.

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

There is no update prompt. Each tab tap and each link loads a page from the
network, so a new release of the part reaches the phone with the next page.

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

Judge loading speed on a production build. In production, every stylesheet,
script, and font has a versioned address and stays in the phone's browser
cache, so a tab switch loads only its page. A development stack serves the
same files uncompressed and asks the server again for each of them on every
page. Over a slow or remote connection, such as a VPN, a tab switch then takes
a second or more, while the same switch in production takes a few hundred
milliseconds.
