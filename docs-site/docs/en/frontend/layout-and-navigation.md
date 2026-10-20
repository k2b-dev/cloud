---
title: Layout and navigation
navTitle: Layout and navigation
section: Frontend
order: 820
description: Place application pages in the shared Cloud layout and navigation.
tags: [layout, navigation, breadcrumbs, page trail, back link]
updated: 2026-10-18
---

# Layout and navigation

Wrap a Cloud application page in `Layout`, `AdminLayout`, or `MinimalLayout`.

The shared layout provides the app bar, the phone header, app navigation,
mobile navigation, global search, help, profile preferences, and, on anonymous
pages, breadcrumbs and a footer.

Layout owns Cloud chrome; an [application shell](/en/docs/frontend/application-shells)
owns the geometry inside it.

Application authors put objects in the sidebar and views of the open object
in `AppWorkspace.Head` as `ViewTabs` links with `?view=`. Filter chips and
quiet secondary actions share that row while the workspace width permits;
filters wrap and the quiet filtered result count disappears first. Put the
one filled primary action in `Head.primary`; on phones the shell leaves its
place beside the bottom bar. See [Objects on the left, views in the head](/en/ui/layout/workspace#objects-on-the-left-views-in-the-head)
for the complete rule and API.

## Know the shell at each width

The shell has three forms. They are CSS on the same server-rendered markup, so
a page arrives in its final form and nothing moves when its islands mount or
when people navigate.

| Width | Signed-in pages | Anonymous pages |
| --- | --- | --- |
| Below 768 px (phones) | App gradient with a title row, search, help, and the app menu; a soft content card and a floating bar with Home and the first apps of the app bar | Flat header with Home, the app name, help, search, the app grid on app pages, theme and language, and sign-in |
| 768 to 1023 px (tablets) | No header. A 60 px app bar in a rounded gradient container sits beside the app card. Both have 20 px corners, 8 px spacing to the window edges, and 8 px between them | The same header controls; header, content, and footer as cards on the app background |
| From 1024 px | No header. The 56 px app bar sits on the app background. The app area is a card whose spacing grows from 4 px at 1024 px to 8 px at 1440 px and whose radius grows from 10 px to 14 px. Wider windows keep those dimensions | Header with breadcrumbs, theme and language, and sign-in; cards on the app background |

Where the app area is a card, the outermost workspace is that card. It has
rounded corners and the card's frame, also when it is `flat`. Render that
workspace as the page's own content, not inside a wrapper element, so it fills
the app area and its frame shows in the card spacing. A page without a
workspace shows its content on the app background, so scroll the content in a
`ScrollArea` and do not wrap it in an opaque surface that fills the app area.
When the sidebar is hidden, also together with the app bar, the work area
takes its column and rounds its start corners with the card, so nothing in the
workspace paints past the card's corners.

From 768 px the app bar holds Home, the button that hides the sidebar, the
apps, the app grid, search, help, and the profile avatar. Its controls are
44 px targets. From 768 to 1023 px the app bar's container carries the app
gradient on a neutral canvas. The selected app has a surface background, and
there is no separator between shortcuts and apps. Announcements and account
notices above the app are cards with the same 8 px spacing.

The installed app on a tablet reports safe areas, such as the status bar and
the home indicator. From 768 to 1023 px these insets add to the 8 px spacing:
the app bar and card stay clear of them on every side. From 1024 px the card
and app bar stay below the status bar. The card keeps its spacing at the
bottom, and its surfaces keep their content
above the home indicator.

Below 768 px, including narrow tablet split views, the signed-in canvas
shows the app gradient. Its title row has no line or surface fill and holds
the app's name, search, help, and the app menu in that order. **Home** moves
from the header to the first place of the floating bottom bar. The bar then
shows the first four links of the person's app bar, shortcuts included, in
the same order. When the current app comes later, it takes the fourth place,
so the bar always marks it. The open item is the surface color on the bar's
app gradient. Home is marked on the start page that `/` opens. When the
person changes their app bar, the bar follows without a reload.

The phone's content is a soft card with 28 px top corners. A regular signed-in
page scrolls inside that card (`main`), while the window stays still. Content
wider than the card scrolls sideways inside it, as from 768 px. The card
keeps space for the bar at its end and when scrolling to a focused control.
The bar sits 8 px above the bottom safe area; the title row and canvas keep
the top and side safe areas. Anonymous phones retain Home in the header, its
bottom line, a flat surface, and document scrolling. The phone app's own flat
bottom bar is unchanged.

Applications need no changes for any of this. `AppWorkspace` adds its compact
navigation between 768 and 1023 px on its own; see
[Application shells](/en/docs/frontend/application-shells#supply-mobile-navigation).
Signed-in pages show the way up to the pages above them instead of a
breadcrumb header; see [Show the way up](#show-the-way-up).
A regular page, without `fullWidth` or `fullPage`, owns its inset: from 768 px
no header sits above a signed-in page, so give the content its own padding, as
`AppOverview` does.

From 768 px, `AppWorkspace.Detail` is a column when it fits beside Main's
minimum (320 px, raised with `AppWorkspace.Main minWidth`). Otherwise it waits
behind **Details**; selecting an item opens it directly as a drawer. The
column shares the workspace surface. The drawer sits flush with the app card's
edge; Escape parks it and returns focus to Details. Opening Cloud's panel
parks the drawer; closing the panel restores the column if it fits. The panel
never closes automatically. Below 768 px, Detail remains a phone sheet or page.
Use `scrollClass="k2b-detail-trail"` on DataTable or mark a board's horizontal
scroller with `k2b-detail-trail` so its last item can scroll beside an open drawer.
See [Detail and panel](/en/ui/layout/workspace#detail-and-panel) for sizing,
focus, gestures, and the close-action contract.

### Hide the app bar and navigation

From 768 px, **Hide sidebar** below Home in the app bar or `Cmd+\` (`Ctrl+\`
on other systems) hides the app bar. From 1024 px, it also hides the outermost
workspace's sidebar; from 768 to 1023 px that sidebar is an overlay behind the
workspace head's button anyway. The shortcut is listed under keyboard
shortcuts in Help. The **Show sidebar** button at the bottom start corner
of the app area, the same shortcut, or a drag from the left edge on a touch
screen shows them again. The browser remembers the choice in a cookie, so a
reload shows the same page. Phones ignore it. On keyboard layouts without a
direct backslash key, such as German, use the button.

Applications need no code. Keep actions people need available outside the
sidebar too, through the application's own links.

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

The last entry is the page title: it names the browser tab and the page in
the shell. The entries above it are the pages above this one; on signed-in
pages the shell turns them into the way up (see below). Anonymous pages show
the entries as breadcrumbs in their header from 1024 px; the final breadcrumb
has no link. A plain string is valid for a one-level title.

Signed-in pages show the shared panel slot when at least one authorized
application declares a provider. Use `panel={false}` to hide it on sign-in,
print, presentation, or public pages that use `Layout`. Anonymous pages have
no slot. `PanelLayout` renders the provider page itself, without shell chrome.
See [Offer a panel](/en/docs/platform/panels).

`help?: string[]` names two or three articles from the current app's Help that
fit this page, for example `help={["inventory-start", "inventory-access"]}`.
Help lists them first under **For this view**, in the declared order. Cloud
removes duplicates, ignores IDs outside the reader's authorized Help manifest,
and keeps at most three IDs of at most 180 characters each. Without a manifest, the section is absent. These
articles stay in their usual task tiles or kind groups too. See
[In-product Help](/en/docs/platform/help#use-the-automatically-derived-surfaces).

`context?: { scope?: CloudResourceRef } | false` reports the current place to
the visible panel, for example
`context={{ scope: { type: "inventory.warehouse", id: warehouse.id } }}`.
Use the public ID the owning app's resource reader accepts. Cloud adds the
current app ID and the filtered `help` IDs above. An invalid scope is omitted;
`context={false}` disables all context for the document. With no current app
or no panel slot, there is no context.

When the place changes inside one document, publish its current scope from a
reactive effect in browser code. Dispose that effect's previous publication
when it changes or unmounts:

```ts
import { publishPageContext } from "@k2b/cloud/browser/panel";
import { createEffect, onCleanup } from "solid-js";

createEffect(() => {
  onCleanup(publishPageContext({ scope: currentScope() }));
});
```

Each call owns one source. The most recent active source with a scope wins;
disposing it reveals the next source, then the server scope. Publishers work
before the lazy panel controller loads and across independent islands. Cloud
asks consent per provider app before sharing; Core providers need no consent.
See [Page context](/en/docs/platform/panels#page-context) for reading it and
its authorization boundaries.

`printHint?: string` supplies the application's final localized export or printing guidance. In regular and focus mode, `Layout` appends a screen-hidden `data-print-fallback` as the last child of the app canvas. When no `data-print-region` exists, only this fallback prints. Its default hint is “Open the item you want to print, or use the app's export.” Pass an app-specific sentence, such as “Open a note to print it, or download it as a PDF from the note's details.” See [Browser printing](/en/ui/layout/print) for marking printable content.

Use `fullWidth` for a multi-column workspace. Use `fullPage` for a fill-height
surface without the footer. Full-page and focus-mode surfaces contain viewport
overscroll: their inner content, including embedded editors, owns scrolling
without moving the outer Cloud shell or triggering pull-to-refresh.

The shell measures the visible window with the dynamic viewport (`dvh`), not
`vh`. Signed-in pages, pages from 768 px, and full-page surfaces at every
width are exactly as tall as the window and scroll their content inside it.
Below 768 px, a regular anonymous page grows with its content. `vh` follows
the larger viewport of a browser whose toolbar can collapse, such as Safari on
iPad, so a page sized with it would scroll by that difference although its
content fits. Full-page Help follows the same rule. A surface that renders
without the shell, such as a pop-out window or an unattended display, takes its
height from `dvh` too, with `h-dvh` or `min-h-dvh`.

The layout reserves a stable scrollbar gutter on every page scroller it owns:
the content area of regular pages from 768 px and, below 768 px, the soft card
of signed-in pages and the document of anonymous pages, except full-page and
focus-mode surfaces. Switching between short and long pages or tabs therefore
does not shift the content sideways where scrollbars take layout space.

Every Cloud page, with any layout, preloads the Latin IBM Plex Sans faces at
weights 400, 500, and 600 next to its stylesheets. The first frame therefore
uses the final font, and text does not re-wrap and move the page when the font
arrives. Other faces load when the page first uses them and appear with
`font-display: swap`: bold (700), italic, IBM Plex Mono, and scripts outside
Latin. Keep them out of lines whose wrapping decides where the rest of a page
sits, especially on a vertically centered page.

Every page also preloads the Tabler icon font. It is much larger than the text
faces, so on a slow connection it can still arrive after the first frame. Until
then, each icon already has its final width, so buttons and text next to it do
not grow or move sideways when the font arrives.

An application preloads the font files of the `@k2b/ui` release that its
`@k2b/cloud` version depends on, and Core serves the files of its own release.
When a font update changes the files between those two releases, the preloads
return 404, and the page shows the fallback font until Plex loads. Update
`@k2b/cloud` to Core's release to preload the right files again.

Do not reproduce Cloud chrome inside application content.

## Show the way up

Give every page its title array and nothing else: on signed-in pages the shell
derives the way up from it by one rule, the same for built-in and third-party
apps.

1. The last entry is the page. Above it, Start (`href: "/"`), the app's own
   root (an `href` equal to the app's route prefix, such as `/app/accounts`),
   entries without an `href`, and an entry that links to the page itself are
   dropped. The app bar already leads to Start and the app. Admin is the root
   of its area in the same way: an `AdminLayout` page shows its title alone,
   whether Core or an application owns it.
2. What remains are the levels below the app root. Their number alone decides
   the form:

| Levels | Form |
| --- | --- |
| 1 | The title only. |
| 2 | `‹ Parent` above the title. |
| 3 or more | A path row with every level above, each a link, above the title. When the row does not fit, its middle collapses into `…`, a menu of the hidden levels; the first level and the parent stay. |

The row above the title is 12 px text and the title 14 px, stacked in one
46 px row, so the height never changes between depths and a list beside a
detail keeps the same height. Below 768 px a back arrow left of the title
replaces the row; its accessible name names the parent, for example "Back to
Users". Depth decides rather than the app, so the same depth looks the same
in every app, and an app cannot pick a form that breaks on a narrow screen.
Anonymous pages, which keep their breadcrumb header, and focus-mode surfaces
such as pop-out editors show the title alone.

The way up appears where the page's title belongs:

- In an `AppWorkspace`, its head above the work area shows it. On a one-level
  page the head stays away from 1024 px, because the app's own heading or its
  sidebar names the page and the app bar marks the app; from 768 to 1023 px
  the head also holds the navigation button and then shows the title alone.
  So a one-level page without a heading of its own shows no title from
  1024 px; render a heading or `PageTrail` when the page should name itself.
- A page without a workspace gets a row from the shell above its content, only
  when there is a level above.
- An app that draws its own header places `PageTrail` there, from
  `@k2b/cloud/ssr/islands`. It shows the same title and way up from the same
  title array, as a heading, and the head and the shell's row step back while
  it is on the page:

```tsx
import { PageTrail } from "@k2b/cloud/ssr/islands";

<header class="flex min-h-[2.875rem] items-center gap-2 px-2">
  <PageTrail subtitle={formatDuration(entry.minutes)} />
  <TimerButton />
</header>
```

From 1024 px, when a visible, non-collapsed workspace sidebar marks the exact
current page with `aria-current="page"`, the workspace shows no title row and
no back link. `AppWorkspace.SidebarItem active` renders that attribute. The
page title stays the document title, and a visually hidden `h1` on a page
that has no `h1` of its own in Main. Pages
deeper than the sidebar lists keep their back link, as do compact layouts
from 768 to 1023 px and phones. Alt+Up still goes to the parent.

Name the page in its content: Grids names the table in its search field with
text such as "Search Devices…"; Spaces names the space above its views in
the sidebar; a note in Notebooks has its own first heading. The sidebar also
names the page. Mark the exact current page with `active`; on
a page deeper than the sidebar lists, mark the containing item with
`active="ancestor"` so it stays highlighted and the page keeps its back link.

The links keep the parent's `href` from the title array, so a new tab, a
copied link, and a reload lead to the page itself. A plain click returns to
the page as this tab left it: Cloud remembers each page's last URL and scroll
position per tab, so filters, search, and position survive the way down and
back up, and the row that led down is marked. A page below the parent, such as
a document whose address carries its folder's query, never counts as the
parent. Put a list's filters into the parent's `href` when a page knows them,
as Accounts does for its user list.

**One level up** (`Alt+↑`, `⌥↑` on a Mac) goes to the parent the same way.
It is a context command: help, the command palette, and the shortcut list show
it, with the parent's name, only on a page with a level above. It does nothing
while the focus is in a text field, and a focused widget that uses the keys
itself keeps them, such as a tree item that moves up or an open list.

After an in-page navigation, call `layout.update()` from the island with the
new title array; the way up, the head, and `PageTrail` follow, also a
`PageTrail` rendered on the server. The array follows the same rule as on the
server. Cloud finds a link to the page itself by the address at the end of the
current task, so change the address in the same task, before or after the
call. `title` alone renames the page and keeps the levels above it:

```ts
import { layout } from "@k2b/cloud/ssr/layout-runtime";

layout.update({ breadcrumbs: [{ title: "Files", href: "/app/files" }, ...folders, { title: folder.name }] });
layout.update({ title: note.title });
```

An island that navigates in place, such as a file browser with running
uploads, takes the way up itself: `layout.handleUp()` gets the destination,
the parent as this tab left it, and returns `true` when the island goes there
in place. Otherwise the page loads. The destination is always a path on this
origin. A level whose link leads elsewhere, or to a path that starts with `//`
and would read as another host, stays a plain link.

```ts
const stop = layout.handleUp((href) => {
  if (new URL(href, location.origin).pathname !== "/app/files") return false;
  void openFolder(href);
  return true;
});
onCleanup(stop);
```

Do not add a back button of your own for a page the title array already
leads up to. Keep buttons that do something else, such as leaving an editor.

An app whose content already holds the way up, as the Files listing does with
its parent row, passes only its root and the current page for those pages.
The shell then draws no back link there at any depth. The app registers its
own context command for `Alt+↑` with `registerContextAwareCommand` from
`@k2b/cloud/browser/commands`, because **One level up** is offered only on a
page with a level above.

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
rail, or canvas styling:

```tsx
import { MinimalLayout } from "@k2b/cloud/ssr";

return () => (
  <MinimalLayout c={c}>
    <main class="flex flex-1 items-center justify-center p-4">
      <PublicDocument document={document} />
    </main>
  </MinimalLayout>
);
```

`MinimalLayout` installs the request locale, persisted theme, and browser
timezone wiring expected by Cloud and `@k2b/ui`. It ends the page with a
footer that holds the legal links of all running applications and the
language and theme settings for visitors. The legal links come from the
runtime registry, so they appear when the router installs
`middleware.runtime()`. The language control shows the current language and
switches between English and German. The theme button shows the current
choice. Each click switches to the next: **Automatic**, **Light**, **Dark**,
then **Automatic** again. Below the `md` breakpoint both controls are compact:
the language control shows the language code, such as `DE`, and the theme
control only its icon. The full
language name remains its accessible label. The theme button's accessible
name states the current choice and the next one. Where the legal links and
the controls do not fit one row, the controls move to a second row below the
links. On touch screens, every footer control is at least 44 px tall, and no
control covers another.

The page content and the footer share one column that is at least one
viewport tall, and the content comes first. On a short page the footer sits at
the bottom of the screen, and on a long page it follows the content. To fill
the space above the footer, give the content root `flex-1`, not
`min-h-screen`, which would push the footer below the first screen. An app
surface that scrolls inside itself uses `flex: 1 1 0` with `min-height: 0`.

Set `preferences={false}` for embeds or fixed presentation surfaces, such as
an unattended display, that must show neither legal links nor controls. The
layout then adds no wrapper around the content. The older corner values
`top-left`, `top-right`, `bottom-left`, and `bottom-right` are deprecated and
behave like the default.

The application remains responsible for its one semantic `main` landmark and
all page styling. Do not add a second language or theme control or a second
legal-links footer to the page. Do not use `MinimalLayout` as an
access-control signal: route middleware, public grants, and share-token
validation remain separate server responsibilities.

### Show the page's one card flat on phones

A standalone page often shows its content in one centered card: an unlock
form, a shared document, a short public form. Give that card the
`standalone-card` class:

```tsx
<MinimalLayout c={c}>
  <main class="flex flex-1 items-center justify-center px-4 py-8">
    <Paper as="section" elevated class="standalone-card w-full max-w-md p-6">
      <UnlockForm />
    </Paper>
  </main>
</MinimalLayout>
```

From Tailwind's `md` breakpoint (48rem, 768 px at the default font size) the
card looks as it does without the class. Below it, the card has no border,
radius, shadow, surface color, or padding of its own: the content sits on the
page background inside the page padding, and fields use the full width. It
also stops clipping its content, so the focus ring of a full-width field or
button at its edge stays whole, even on a card with `overflow-hidden`. Page
layout that changes with `md:` switches at the same width, also when a reader
has set a larger default font size. The class works on a `Paper`, on the
`paper` utility, and on a card built from utilities. It is one CSS rule on
unchanged markup, so the page arrives from the server in its final form and
nothing moves afterwards.

Keep the page padding on `main`, not on the card, and do not select the flat
variant from the user agent or in an island. Use the class only for the single
card that is the page; cards inside an application layout keep their frame.
The Core sign-in, password, and consent pages use the same class.

## Use the responsive profile menu

Authenticated users change the theme or language from the profile menu and
can open `/me` for the remaining profile settings. While the installation runs
the mobile app (the `pwa` application), the menu also shows **App**, which
leads to `/me/app`, where people pair and remove phones. The menu ends with
**Sign out**. Applications do not add their own link to any of these.
Anonymous `Layout` pages expose the same preferences in the header without
profile actions, and `MinimalLayout` pages show them in their footer.
Applications must not add a second theme or language control to their own
content.

The layout places the profile menu with CSS:

- Below 768 px, the app menu in the header holds the profile actions; the
  title row has no avatar. Home and the apps are in the bottom bar.
- From 768 px, the avatar is the last control of the app bar, below search and
  help. Its menu opens beside the app bar and grows upward from the avatar.

With a mouse or trackpad, pointing at or focusing the avatar opens the menu.
On touch screens and other coarse pointers, tapping the avatar opens the same
menu as a dropdown.

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

## Show a count on the app icon

An application can show how many items wait for the signed-in person, such as
unread mentions, as a count on its icon in the app bar and the app grid.
Declare a route the application serves:

```ts
nav: {
  href: "/app/inventory",
  section: "primary",
  badge: "/api/inventory/badge",
}
```

Serve it like any other authenticated route and return an `AppNavBadge` from
`@k2b/cloud/contracts`:

```ts
import type { AppNavBadge } from "@k2b/cloud/contracts";

router.get("/api/inventory/badge", async (c) => {
  const count = await countOpenRequests(c.get("accessSubject"));
  return c.json({ count } satisfies AppNavBadge);
});
```

- **Route:** `badge` is a same-origin path below one of the application's
  `routes`, also after resolving `.` and `..` segments. `defineApp()` throws
  at startup for any other value, and the registry rejects such an entry.
  The browser calls it with the person's session, so the route policy and
  the application's permission checks apply as for every request.
- **Count:** a positive safe integer shows the count, above 99 as `99+`. `0`,
  any status other than `200`, a body without a valid `count`, a failed
  request, and a request still running after a minute show no badge. Keep the
  route cheap: count, do not list.
- **When it is read:** the server render never calls the route and never
  shows a count. After the page loads, the shell reads every badge route of
  the person's navigation once, then at most once per minute while the tab is
  visible, and again when a hidden tab becomes visible after a minute or more.
  Hidden tabs send nothing. Each route has at most one request in flight per
  tab, and each count appears as soon as its own answer arrives, so a slow
  application delays only its own badge.
- **Layout:** the count sits over the corner of the icon, so appearing,
  growing, or clearing moves nothing. Screen readers hear it with the app's
  name, for example "Chat, 3 new".
- **Fresh after a change:** after the person changed what the badge counts,
  for example by reading a conversation, call `refreshAppBadges()` from
  `@k2b/cloud/browser/app-badges` so the app bar agrees with the page at once.
  Calls while a read is still running share one more read after it, so
  frequent calls never stack up requests. It does nothing in a hidden tab or
  outside the Cloud layout.

An application without `badge` renders exactly as before. A badge is a hint to
open the application, not authorization or a live view; the application's own
pages show the current state.

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
the app launcher. Shortcuts occupy a compact first row of smaller icon tiles,
with labels below the icons and spacing before the app catalog. The row has
no visible heading or divider. All shortcuts use a persistent neutral icon
background without button borders.

Core stores these preferences per user; the platform loads them before SSR
through a shared Valkey cache. Applications do not need to fetch or
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

## Provide global app bar shortcuts

Administrators open **Administration → App bar** (`/admin/rail`) to create,
edit, reorder, or remove global shortcuts. Each shortcut points to an available
app or a link with a title and icon.

The full-width table lists shortcuts in their app bar order. New shortcuts
are visible to **All signed-in users** by default. Turn on **Restrict audience**
to show the permission editor and select individual users or groups. Turning
the restriction off makes the shortcut visible to all signed-in users; draft
selections are retained if you turn it back on before closing the dialog.
Nested group membership is respected. An enabled restriction with no selected
audience makes the shortcut visible to nobody. Existing restrictions are preserved. Audience changes and shortcut edits
are saved together; closing the dialog discards unsaved changes after
confirmation. Concurrent changes return a conflict instead of overwriting
another administrator's configuration; reload the page before trying again.

Global shortcuts appear before personal shortcuts in the desktop app bar and
the mobile launcher. Users see them under **Provided by the administration**
in their personal editor and cannot change or remove them. Resetting personal
settings preserves global shortcuts. An app pinned globally and personally is
shown once, while the personal pin stays saved and reappears if the global pin
is removed. Unavailable apps remain omitted. A shortcut's audience controls its
visibility; the destination still enforces its own authorization.

The Core admin API is `GET /api/admin/core/rail` and
`PUT /api/admin/core/rail`. The snapshot contains `revision` and ordered
`entries`. Each entry has a `shortcut` and an `access` list. Write each grant
as `{ principal, permission }`; returned grants also carry IDs and display
metadata. Only `read`
grants to users, groups, or the authenticated audience are accepted. Writes
replace the complete configuration and require its current revision. The
personal `/api/me/rail` API remains separate and accepts only personal settings.

Apply the Core `rail-shortcuts` migration before restarting applications with
this platform version. The migration adds the shared shortcut tables and
transactional cache versions. The existing identity query reads the current
global and personal versions together with the user. A warm per-user Valkey
snapshot therefore avoids additional rail database round trips, including the
personal preference read. Changes to global shortcuts, grants, and group
membership invalidate old generations transactionally. Personal changes
invalidate that user's snapshot. A late cache refill cannot overwrite a newer
generation. Unused cache entries expire after five minutes; a Valkey failure
falls back to Postgres. This cache does not replace the normal identity checks.

The admin page explains this behavior and offers **Clear cache for all users**.
`DELETE /api/admin/core/rail/cache` requires an administrator at both the route
and service boundary. It changes the shared cache generation with one database
update, without enumerating users or Redis keys. It leaves the configuration
revision unchanged, so open editors can still save. Subsequent requests rebuild
their snapshots; invalidated entries expire within five minutes.

Keys use `appglobalcache:user:<userId>:rail:v1:<globalVersion>:<personalVersion>`.
The common `appglobalcache:user:*` prefix reserves a namespace for per-user
application caches; `rail` identifies the current payload. Other payloads can
be added separately when needed. To inspect keys, operators can use
`redis-cli --scan --pattern 'appglobalcache:user:*'`. Prefer the admin action for
invalidation: a concurrent request cannot refill the active generation with
old data. Prefix deletion alone does not provide that guarantee.

Changes take effect on the next server-rendered navigation or reload. Already
open pages are not pushed administrative changes. Saving personal settings
still updates the current page immediately and preserves its managed entries.
The personal snapshot and global configuration each have a 16 KiB budget;
managed shortcuts add at most 16 KiB to the page's personal rail snapshot.

## Render an admin page

```tsx
<AdminLayout c={c} title="Inventory">
  <h1 class="text-base font-semibold text-primary">
    Inventory
  </h1>
  <InventoryAdminPanel />
</AdminLayout>
```

`AdminLayout.title` names the page. Admin is the root of its area, so every
admin page is one level deep and shows no way up, whichever app owns it; the
admin sidebar leads between the pages. The page renders its own heading.
The admin shell stays within the viewport, with independent sidebar and content
scrolling. For a bounded child such as `SettingsPage`, pass `scroll={false}` to
`AdminLayout`: the child then owns content scrolling and its fixed save footer.
The default remains `scroll={true}` for ordinary admin pages.

App-owned admin groups come from `adminNav` in the application declaration.
A group may declare `section: "ai"` to contribute its links to the shared AI
section instead of creating a separate navigation group. This placement is
available to any application and does not grant access; its routes and services
still enforce their own permissions. Omit `section` for an independent group.

## Use anchors for navigation

Navigation controls start as anchors with an `href`. A link must work before
the page's islands mount and support open-in-new-tab.

Use enhanced navigation only inside an island that also updates its own state.
See [URL state and navigation](/en/docs/frontend/url-state-and-navigation).

## Show the container an app works in

Use `AppWorkspace.SidebarSwitcher` when the app works inside one container
chosen from several and the sidebar shows that container's contents: a
notebook's pages, a base's tables, a mailbox's folders, or a venue. When the
containers are themselves the objects, list them as sidebar rows instead, so
another one is one click away; Spaces lists every Space this way. Put the
switcher first in `SidebarDesktop`, above the navigation for that container.
It replaces
app-made **All …** sidebar rows with one head and a panel of containers and
actions. Offer **New …** only to people who may create, and **All …** as a
link to the overview.

Filters, projects, and lists that are ordinary sidebar destinations remain
rows. Apps without a current container need no switcher.

Load options on demand through `onLoad`, leaving `options` undefined while
waiting; ignore repeated calls during a request and pass `error` when it fails.
Pass the same props to `createNavigation({ items, switcher: () => switcher })`
and register that navigation with `WorkspaceNavigationProvider` so phones get
the same head in the host menu. See the
[Switcher example and API](/en/ui/layout/workspace#switcher) for placement,
search, and keyboard behavior.

## Mobile workspace menu

Below 768 px, the header launcher hosts the current application's navigation
and an **All apps** switch. Pages with `WorkspaceNavigation` also turn the
phone title into **Name ⌄**, which opens the same menu. Other pages keep the
plain title. An overview sidebar with `mobile="stacked"` shows a horizontally
scrolling row of object chips above the content below 64 rem; **All** opens
the complete sidebar in a bottom sheet below 48 rem and a centered dialog
from 48 rem. From 768 px the app bar and the workspace's own
navigation take over. The mobile workspace uses the full canvas without a
second application title or exterior frame. See [Application shells](/en/docs/frontend/application-shells#supply-mobile-navigation)
for the SSR snapshot and island-owned action APIs. `@k2b/ui` remains independent
of Cloud; Cloud owns registration, the launcher, and menu history.
