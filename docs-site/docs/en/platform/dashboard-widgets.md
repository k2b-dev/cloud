---
title: Dashboard widgets
navTitle: Dashboard widgets
section: Platform services
order: 570
description: Add application-owned information to the shared Cloud dashboard.
tags: [dashboard, widgets, authorization]
updated: 2026-10-10
---

# Dashboard widgets

A widget shows a small, current summary from an application on the shared
dashboard.

The application owns one authenticated handler. Cloud discovers its declared
widget, sends the user's session only to Core, and renders the shared widget
blocks. Core exchanges that session for a 30-second invocation JWT bound to the
target app and exact widget ID. The provider reloads the current actor and
performs its normal authorization; it never receives the source cookie.

Cloud also forwards the Dashboard request's resolved locale in the
`x-cloud-locale` header. Resolve it with `getLocale(c)` in the endpoint; do not
rely on `Accept-Language` surviving the server-side fan-out.

## Declare a widget

```ts
export const app = defineApp({
  id: "inventory",
  // ...
  presentation: {
    baseLocale: "en",
    translations: {
      de: { widgets: { stock: { title: "Bestand", description: "Knappe Artikel in allen Lagern." } } },
    },
  },
  widgets: [
    {
      id: "stock",
      path: "/api/inventory/widget/stock",
      title: "Stock",
      description: "Low-stock items across all warehouses.",
      sizes: ["small", "medium"],
      defaultSize: "medium",
      suggest: true,
    },
  ],
});
```

The ID must be unique inside the application and must not contain `@`, which
separates a widget from the size the dashboard asks for. The path must be an
absolute route served by that application.

| Field | Meaning |
| --- | --- |
| `title` | Name in the dashboard and its gallery, up to 80 characters. Defaults to the app's name. |
| `description` | One sentence for the gallery, up to 200 characters. Defaults to the app's description. |
| `sizes` | Sizes the widget offers: `small`, `medium`, `large`. Defaults to `["large"]`. |
| `defaultSize` | Size the widget starts in, one of `sizes`. Defaults to the largest offered size. |
| `suggest` | Put the widget on the default board and under **Suggested for you**. |
| `requiresRoles` | Offer the widget only to people with one of these roles, like `nav.requiresRoles`. |

Translate `title` and `description` under
`presentation.translations.<locale>.widgets.<id>`. `defineApp()` rejects a
duplicated ID or one with `@`, an empty or overlong text, an unknown size or
role, a `defaultSize` the widget does not offer, and a `suggest` that is not
`true` or `false`.

`requiresRoles` only decides what the gallery and the default board offer. It
is not authorization: the handler still checks every request and answers
`403` to anyone who may not see the widget.

Suggest only widgets that are useful without any setup and that rarely have
nothing to show. A suggested widget appears on the board of everyone who has
not arranged their own board yet.

### Choose sizes

The board has four columns on wider screens and two on phones. Every widget
has one of three fixed sizes:

| Size | Four columns | Phone | Typical content |
| --- | --- | --- | --- |
| `small` | one column, one row | half the width | one number, one status, or one hero |
| `medium` | two columns, one row | full width | a status with its counts, or two list rows |
| `large` | two columns, two rows | full width, two rows | a list of about six rows, or several blocks |

A row is about 10.5rem high, so a small or medium widget has room for about
7rem of content below its header. Offer a size only when the handler fills it
well. A widget without `sizes` offers only `large`, the height every widget
had before sizes existed.

`presentation.defaultZone` and `presentation.defaultSpan` are deprecated: the
dashboard has no zones or widths any more. Declare `sizes` and `defaultSize`
instead, and keep an existing `presentation` for now. The dashboard reads it
only to convert a board saved before sizes existed into the board the person
saw.

### Register the handler

Export the Hono handler used by that route and register the same function with
`app.start()`:

```ts
import { type AuthContext, getWidgetRequest } from "@k2b/cloud/server";
import type { Context } from "hono";

export const stockWidgetHandler = async (c: Context<AuthContext>) => {
  const { size } = getWidgetRequest(c);
  // Load and authorize c.get("accessSubject"), then return a WidgetResponse that fits `size`.
};

export default await app.start({
  fetch: router.fetch,
  widgets: { stock: stockWidgetHandler },
});
```

The declaration is the discovery contract; the `app.start({ widgets })` map is
the framework-owned internal invocation contract. Startup rejects an internal
handler whose ID was not declared. Invocation JWTs are accepted only by the generated internal widget
route, never by the public application route.

`getWidgetRequest(c)` returns `{ size }`: the size the board shows the widget
in, always one the widget declares. Return the content that fits it, for
example only the most important number in `small` and a longer list in
`large`. Outside a dashboard invocation, such as a request to the handler's
own public route, the size is `large`.

## Return widget data

```ts
import type { WidgetResponse } from "@k2b/cloud/contracts";

const body: WidgetResponse = {
  title: "Inventory",
  icon: "ti ti-package",
  href: "/app/inventory",
  meta: "today",
  blocks: [
    {
      kind: "stat",
      value: lowStockCount,
      label: "Low-stock items",
      accent: { tone: "amber", icon: "ti ti-alert-triangle" },
    },
    {
      kind: "list",
      items: items.map((item) => ({
        label: item.name,
        meta: String(item.quantity),
        href: `/app/inventory/items/${item.id}`,
      })),
      emptyMessage: "Stock levels are healthy.",
    },
  ],
};

return c.json(body);
```

The top-level response requires `title` and `blocks`. It also accepts `icon`,
`href`, and `meta`. The complete serialized response is limited to 128 KiB.
Cloud validates and reserializes it before the dashboard sees it. Unknown
fields are stripped for compatibility; oversized strings or collections,
malformed JSON, and non-finite numbers are rejected.

## Choose a block

Every block has one `kind`. Fields not listed for that kind are not part of the
contract.

| Kind | Required fields | Optional fields |
| --- | --- | --- |
| `stat` | `value`, `label` | `sub`, `valueClass`, `accent`, `grow` |
| `list` | `items` | `emptyMessage`, `grow` |
| `status` | `tone`, `title` | `message`, `icon`, `grow` |
| `pills` | `pills` | `grow` |
| `placeholder` | `title` | `description`, `icon` |
| `hero` | `title` | `subtitle`, `icon`, `tone` |

A stat `accent` requires `tone` and `icon`; it can also contain `text`.

Each list item requires `label`. It can contain `icon`, `iconTone`, `sub`,
`meta`, and `href`.

Each pill requires `label` and `value`. It can contain `tone` and `href`.

Every `href`, including links inside list items and pills, must be a safe
relative reference or an absolute HTTP(S) URL. Active schemes such as
`javascript:`, backslashes, and control characters are rejected. Protocol-relative
HTTP(S) links are accepted too.

`WidgetResponse` contains final display strings, never catalog keys. Numeric
`stat.value` and `pill.value` fields are formatted automatically by `@k2b/ui`
for the inherited locale; string values remain byte-for-byte unchanged. Return
a string when the value is already deliberately composed. The application
owns labels, dates, currency, relative time, plurals, list text, empty states,
and error guidance. See
[Internationalize an application](/en/docs/build/internationalization).

Use `placeholder` for a compact empty or unavailable state inside the widget.

Widget tones are `emerald`, `amber`, `red`, `blue`, or `zinc`. Status tones are
`ok`, `warn`, `error`, or `info`.

Use only the fields defined by `WidgetResponse`. Cloud controls widget layout
and visual styling.

## Enforce access in the endpoint

Cloud authenticates the invocation, but it does not authorize application
data. The handler must use the normal request identity and resource permission
checks.

OAuth callers need `read` or `admin` at both the Core widget proxy and the
internal widget route. Session and API-key requests keep their existing access
rules; OAuth scopes never replace the handler's resource permission checks.

Framework-owned internal widget routes provide the same request runtime,
settings, actor, access subject, and resolved locale as public application
routes. Handlers can use the normal runtime context; they do not need a separate
internal-route initialization path.

Return:

- `200` with `WidgetResponse` when the user may see the content;
- `403` when the user lacks the required access;
- `204` when the widget has no content.

A widget keeps its place on the board whatever it answers. A `403` widget
shows "No access any more" in its frame, and a `204` widget shows "Nothing to
show right now". A timeout or another non-success response is logged with a
bounded failure reason and shown inside that widget only.

## Loading, timeouts, and failures

The dashboard page renders the board first, with a frame in the final size for
every widget and a loading state inside it. The browser then asks Core for all
widgets on the board in one streamed request, the same way Universal Search
streams its results, each in the size the board shows it in. Each widget fills
its own frame as soon as its app answers; widgets that already arrived never
wait for slower ones.

- **Concurrency:** Core asks at most eight widgets at the same time and starts
  the rest as earlier ones finish.
- **Timeout:** each widget has its own 8-second budget, counted from the moment
  Core starts it. Core signs every invocation of one dashboard together, so
  widgets do not wait on one another for authorization. A widget still loading
  after three seconds says in its frame that its app is taking longer than
  usual.
- **Stream deadline:** one stream ends after 30 seconds, when the invocations
  Core signed for it expire. Every widget that has not answered by then
  reports `timeout`, including one still waiting for a free place that was
  never asked; **Try again** asks it in a new stream. Only a dashboard with
  many slow widgets reaches this deadline.
- **Failure:** a widget that times out, answers with an unexpected status, or
  returns invalid JSON shows a short message and **Try again** in its own
  frame. Retrying asks only that widget again. The rest of the board is never
  affected.
- **Layout:** the frame's size comes from the board, not from the content.
  Longer content scrolls inside the widget, so put the most important
  information at the top.
- **Resizing:** when a person changes a widget's size, the board asks the
  widget again in the new size and keeps the old content until the new one
  arrives.

Keep widget queries bounded and fast: a widget is a glanceable summary, and a
slow one keeps showing its loading state until it answers or its budget ends.
Link to the application for detailed work instead of turning the widget into a
full page.

## Board and gallery

Each person has one board: an ordered list of widgets, each in one of its
sizes, in the same reading order on every device. Until a person changes
something, they follow the default board: every suggested widget they may see,
in its default size, large ones first. Widgets an app suggests later appear on
it by themselves. After the first change the board belongs to the person; new
widgets then wait under **Suggested for you** in the gallery. **Default** in the
edit mode returns to the default board.

**Edit** or a long press on a widget opens the edit mode. People drag widgets
to move them, which selects no page text, or focus one and use the arrow keys;
they pick a size at the bottom of the widget and remove it with ×. **Add
widget** opens the gallery, which lists the widgets the person may use, grouped
by app, each with a live preview of the person's own data in the chosen size.
The gallery loads a preview only when its card is on screen, at most eight at a
time. **Done** saves the board without reloading the page.

A widget appears on a board at most once. A board keeps the place of a widget
whose app is not running, and shows it again when the app returns.

## Read widgets from a browser

The stream is `GET /api/widgets/v1` with `Accept: application/x-ndjson`. Each
line is a `WidgetStreamLine` from `@k2b/cloud/contracts`: `start` names the
widgets in registry order, one `widget` line follows per widget with status
`ok`, `empty`, `forbidden`, `timeout`, or `error`, and `done` ends the stream.
Repeat `widget=<appId>/<widgetId>` to ask only some widgets, and append
`@small`, `@medium`, or `@large` to ask a widget in that size, for example
`widget=inventory/stock@small`. A widget asked without a size, or in one it
does not offer, answers in its default size. A browser reads the stream with
`streamWidgets()` from `@k2b/cloud/browser/widgets`, which takes the sizes as
`sizes`, keyed by widget; aborting its signal stops every widget Core still
waits for.

`GET /api/widgets/v1/<appId>/<widgetId>` returns one widget as JSON with the
same per-widget budget; append `?size=small` to ask for a size. It answers
`200` with the response, `204`, `403`, `504` for a timeout, or `502` for
another failure.

See [Request identity](/en/docs/identity/authentication) and
[Resource authorization](/en/docs/identity/authorization).
