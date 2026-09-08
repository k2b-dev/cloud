---
title: Dashboard widgets
navTitle: Dashboard widgets
section: Platform services
order: 570
description: Add application-owned information to the shared Cloud dashboard.
tags: [dashboard, widgets, authorization]
updated: 2026-09-03
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

## Register a handler

```ts
export const app = defineApp({
  id: "inventory",
  // ...
  widgets: [
    {
      id: "stock",
      path: "/api/inventory/widget/stock",
      presentation: {
        defaultZone: "overview",
        defaultSpan: "standard",
      },
    },
  ],
});
```

The ID must be unique inside the application. The path must be an absolute
public compatibility route served by that application.

`defaultZone` is `focus`, `overview`, or `context`. `defaultSpan` is `standard`
or `wide`. These are initial recommendations. A user's saved layout wins.

Export the Hono handler used by that route and register the same function with
`app.start()`:

```ts
import type { AuthContext } from "@k2b/cloud/server";
import type { Context } from "hono";

export const stockWidgetHandler = async (c: Context<AuthContext>) => {
  // Load and authorize c.get("accessSubject"), then return WidgetResponse.
};

export default await app.start({
  fetch: router.fetch,
  widgets: { stock: stockWidgetHandler },
});
```

The declaration is the discovery contract; the `app.start({ widgets })` map is
the framework-owned internal invocation contract. Startup rejects an internal
handler whose ID was not declared. Keep the public route during the rolling
migration. Invocation JWTs are accepted only by the generated internal widget
route, never by the public application route.

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

Cloud lists a `403` widget as unavailable at the user's access level. It skips
`204` without a message. A timeout or another non-success response is logged
and rendered as a small error state.

Keep widget queries bounded. Dashboard runs at most eight widget requests
concurrently and preserves registry order. Each started widget receives a
500 ms budget. The page deadline is `ceil(widgetCount / 8) * 500 ms`, so later
waves are not starved by the first eight widgets. More widgets can therefore
increase total page latency without increasing concurrency. Request cancellation
stops queued widgets from starting. Core
also applies a 500 ms deadline to the complete proxy operation, including
registry lookup, invocation signing, provider fetch, and response validation;
a slow or unavailable app must not block the others. Provider failures are
logged with bounded failure reasons; timeout exceptions and HTTP 504 produce
the timeout state rather than a generic error. Link to the application
for detailed work instead of turning the widget into a full page.

See [Request identity](/en/docs/identity/authentication) and
[Resource authorization](/en/docs/identity/authorization).
