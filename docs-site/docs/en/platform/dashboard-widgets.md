---
title: Dashboard widgets
navTitle: Dashboard widgets
section: Platform services
order: 570
description: Add application-owned information to the shared Cloud dashboard.
tags: [dashboard, widgets, authorization]
updated: 2026-08-26
---

# Dashboard widgets

A widget shows a small, current summary from an application on the shared
dashboard.

The application owns an authenticated JSON endpoint. Cloud discovers the
endpoint, fetches it with the user's session, and renders the shared widget
blocks.

Cloud also forwards the Dashboard request's resolved locale in the
`x-cloud-locale` header. Resolve it with `getLocale(c)` in the endpoint; do not
rely on `Accept-Language` surviving the server-side fan-out.

## Register an endpoint

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
route served by that application.

`defaultZone` is `focus`, `overview`, or `context`. `defaultSpan` is `standard`
or `wide`. These are initial recommendations. A user's saved layout wins.

## Return widget data

```ts
import type { WidgetResponse } from "@valentinkolb/cloud/contracts";

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
`href`, and `meta`.

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

Cloud forwards the user's session, but it does not authorize application data.
The endpoint must use the normal request identity and resource permission
checks.

Return:

- `200` with `WidgetResponse` when the user may see the content;
- `403` when the user lacks the required access;
- `204` when the widget has no content.

Cloud lists a `403` widget as unavailable at the user's access level. It skips
`204` without a message. A timeout or another non-success response is logged
and rendered as a small error state.

Keep widget queries bounded. A dashboard may load widgets from many
applications at once. Link to the application for detailed work instead of
turning the widget into a full page.

See [Request identity](/en/docs/identity/authentication) and
[Resource authorization](/en/docs/identity/authorization).
