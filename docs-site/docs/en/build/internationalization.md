---
title: Internationalize an application
navTitle: Internationalization
section: Build an app
order: 165
description: Add translations and locale-aware formatting without breaking Cloud SSR, islands, errors, Help, widgets, or capabilities.
tags: [i18n, intl, locale, ssr, errors, help, widgets]
updated: 2026-08-29
---

# Internationalize an application

Internationalization is opt-in per application. Cloud resolves one canonical
locale for each request and transports it across platform boundaries; the
application owns its human-facing messages and decides which locales it ships.

This page defines where messages and locale-sensitive values live. Follow
[Product language and tone](/en/docs/build/product-language-and-tone) for the
wording of controls, feedback, errors, notifications, and Help in English and
German.

Do not build a locale state store, pass locale through every component, or
duplicate a component per language. On the server, call `getLocale(c)`. In
Solid UI, use the inherited `@k2b/ui` locale. At transport boundaries, use the
locale Cloud already provides.

Cloud's shared profile menu currently lets authenticated users choose English
or German. It persists the choice in the `cloud.locale` cookie and reloads the
current page so SSR remains authoritative. Applications consume the resolved
locale; they do not add their own picker or browser locale state. The request
sources and precedence are documented in [Locale and time](/en/docs/server/locale-and-time).

## Own strings where they are written

Use `@k2b/stdlib` `i18n.define()` for human-facing messages. The base locale
defines the complete, typed key set. Other locales may be partial; lookup falls
back per key from an exact tag through its defined BCP 47 ancestors and finally
to the base locale.

```ts
import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Inventory",
      emptyList: "No items yet.",
      saved: ({ name }: { name: string }) => `${name} was saved.`,
    },
    de: {
      title: "Inventar",
      emptyList: "Noch keine Einträge.",
      saved: ({ name }) => `${name} wurde gespeichert.`,
    },
  },
});
```

Choose the smallest location that keeps the owning code readable:

| Scope | Convention |
| --- | --- |
| A few strings used in one short module | Keep the catalog in that module |
| One feature, component family, API surface, or error boundary | Put `messages.ts` beside the feature |
| Messages reused across unrelated parts of one application | Use `src/i18n.ts` or `src/i18n/index.ts` |
| Long-form content such as Help | Use explicit locale folders under the content owner |

Do not extract a tiny catalog merely because another application might one day
need the same wording. Do extract it when inline translations would obscure the
component, handler, or template. Message keys are implementation details of the
owning application; they never cross an API or capability boundary.

Run `catalog.check()` in a focused test whenever an application ships more than
its base locale. Assert an empty result for a complete release catalog and add
one regional lookup such as `de-CH` to prove language fallback. If a staged
rollout intentionally falls back for some keys, assert the exact known report
instead of omitting the check.

## Resolve once at each runtime boundary

### Hono handlers and SSR

Resolve messages from the request locale:

```ts
import { getLocale } from "@valentinkolb/cloud/server";

router.get("/api/inventory", (c) => {
  const { locale, t } = messages.resolve([getLocale(c)]);
  return c.json({ locale, emptyMessage: t.emptyList });
});
```

Cloud SSR uses that same locale for `<html lang>` and `getDateConfig(c)`.
`Layout` and `AdminLayout` also install the matching root `LocaleProvider`.
If a custom SSR page deliberately uses neither layout, wrap its returned root
once with `<LocaleProvider locale={getLocale(c)}>`. This is root wiring, not a
locale prop to pass through the component tree. Never store a current locale in
module or process state: concurrent SSR requests must remain isolated.

### Solid components and islands

Use `useLocale()` when application code must resolve a message catalog. Shared
`@k2b/ui` formatters and locale-aware inputs already use it internally.

```tsx
import { Button, useLocale } from "@k2b/ui";

const locale = useLocale();
const t = () => messages.resolve([locale()]).t;
return <Button>{t().save}</Button>;
```

An island is a separate Solid root. It does not inherit a server-side context
object, so `useLocale()` falls back to `document.documentElement.lang` in the
browser. Cloud keeps that value equal to the SSR locale. No locale prop plumbing
or browser provider is required.

Generic `@k2b/ui` chrome such as input placeholders, pagination, menus, loading
states, and accessibility labels follows the inherited locale. Explicit labels,
empty text, and descriptions passed by an application are application-owned and
must already be localized.

## Localize registered application presentation

The complete base declaration stays in `name`, `description`, `adminNav`, and
`legalLinks`. Add `presentation` only for localized overlays:

```ts
defineApp({
  name: "Inventory",
  description: "Manage stock and warehouses.",
  adminNav: [
    {
      id: "inventory",
      label: "Inventory",
      links: [{ label: "Warehouses", href: "/admin/inventory/warehouses", icon: "ti ti-building-warehouse" }],
    },
  ],
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Inventar",
        description: "Bestände und Lager verwalten.",
        adminGroups: { inventory: "Inventar" },
        adminLinks: { "/admin/inventory/warehouses": "Lager" },
      },
    },
  },
});
```

Admin groups use their explicit `id`; admin and legal links use their stable
`href`. Cloud validates those references at startup and resolves exact locale,
language ancestors, and the base declaration per field. IDs, routes, icons,
permissions, and link targets never change with language. Runtime navigation,
administration, Help surfaces, API Docs, and app listings all receive the same
request-scoped presentation.

Translate an application name when it is an ordinary word that describes the
app, such as Files, Contacts, Accounts, or Weather. Keep coined product names
such as Grids or Spaces, established loanwords such as Mail or Gateway, and
technical terms the audience normally uses untranslated. Record the decision
explicitly in `presentation`, even when the localized name stays identical.
The name and description must use the same term.

### Localize declared settings

Setting keys and values remain stable. Localize only the presentation attached
to a setting; it inherits the application's `presentation.baseLocale`, so the
base locale is not repeated on every field.

```ts
defineApp({
  presentation: { baseLocale: "en", translations: { de: { name: "Inventar" } } },
  settings: {
    "inventory.endpoint": {
      kind: "url",
      default: "",
      label: "Service endpoint",
      description: "Base URL of the inventory service.",
      placeholder: "For example, https://inventory.example",
      presentation: {
        translations: {
          de: {
            label: "Dienstendpunkt",
            description: "Basis-URL des Inventardienstes.",
            placeholder: "Zum Beispiel https://inventar.example",
          },
        },
      },
    },
  },
});
```

Enum overlays may provide `options` keyed by the stable option value. Cloud
resolves exact locale, language ancestors, and the application base locale on
the server before returning the setting registry.

## Format values instead of translating them

Use semantic values for numbers and time, then format at the rendering owner:

- `Format.Number`, `Format.Percent`, `Format.Currency`, and `Format.Bytes` for
  Solid UI;
- `Format.Date`, `Format.Time`, `Format.DateTime`, `Format.RelativeTime`, and
  duration formatters for temporal UI;
- `@k2b/stdlib` `text` and `dates` helpers in non-Solid server code;
- `i18n.plural()` and `i18n.formatList()` for locale-sensitive composition.

Do not format a number in advance merely to choose `,` or `.`. `NumberInput` accepts and
displays the separator for its inherited locale. Keep timezone separate from
language and pass `getDateConfig(c)` when a date also needs the request timezone.

Do not call `toLocaleString()`, `toLocaleDateString()`, or
`Intl.DateTimeFormat(undefined, ...)` at a user-facing seam. The runtime default
can differ between SSR and the browser. Use the inherited locale or an explicit
request locale. Stable machine formats such as ISO dates are not display text.

## Keep errors useful to humans and machines

Stable error codes, HTTP statuses, and structured details remain
locale-independent. A human-facing `message`, field hint, validation message,
toast, empty state, or recovery action is localized by the layer that owns it.

```ts
return c.json(
  { code: "ITEM_NOT_FOUND", message: t.itemNotFound({ id }) },
  404,
);
```

Clients branch on `code`, never on translated text. Logs use stable event names
and structured fields; do not localize operational log messages. If an error
crosses applications, the provider returns a ready-to-display localized message
alongside its stable code. Cloud localizes its own Capability transport and
validation failures before returning them. The caller must not know the
provider's message keys or maintain a table of its codes just to display useful
feedback.

Never infer a translation key from an English error string or a regular
expression. Give domain failures a stable code or structured reason and select
the final message from that value. When a legacy dependency exposes only a
status and free-form text, preserve its base-locale message and use an
application-owned message for that stable status in translated responses.
Operational diagnostics remain available in logs rather than leaking into the
localized response.

## Cross application boundaries

### Capabilities

Cloud transports the caller preference as `x-cloud-locale` metadata next to
authorization and tracing. It is not part of an input schema or auth token.
Query, Action, and review handlers read `context.locale` and return localized
display strings. Codes remain stable for programmatic handling. See
[Capabilities](/en/docs/platform/capabilities).

### Dashboard widgets

The Dashboard forwards its resolved request locale with the user's session to
every widget endpoint. The application returns final display strings in
`WidgetResponse`; it never returns message keys. Numeric `WidgetStat` and
`WidgetPill` values format automatically in `@k2b/ui`, while string values are
preserved. The application still owns currency, dates, relative time, plurals,
labels, empty states, and composed text. See
[Dashboard widgets](/en/docs/platform/dashboard-widgets).

### In-product Help

One Help declaration can contain all locales in one bounded registration. The
base locale owns the complete logical article set and stable metadata. Localized
folders provide partial title, description, and Markdown variants for those same
IDs. Layout Help, full-page Help, HTTP search/read, AI tools, and MCP all resolve
the request locale through exact tag, ancestors, and base fallback. See
[In-product Help](/en/docs/platform/help).

### Command-line interfaces

Resolve one locale per CLI invocation and carry it through the command
context. `cld` uses an explicit `--locale` option, then `CLD_LOCALE`, then the
deterministic `en` default. It forwards the resolved tag as `Accept-Language`
so application-owned API messages keep the same meaning as browser and direct
API calls. Keep commands, flags, codes, enum values, JSON, and JSONL unchanged;
localize only final human text with explicit catalog keys. See
[Application CLI modules](/en/docs/platform/cli-modules).

### Notifications, email, and long-running work

Resolve text where the final message is produced. For a request-time effect,
carry the resolved locale in the effect's immutable input. For scheduled or
later delivery, persist the intended recipient locale or deliberately use the
operator default; there may be no original request when the job runs. Keep
template structure separate when translations would make a template unreadable,
but do not create one file per sentence.

Notifications and emails must contain final localized subject, body, action
labels, and error guidance. Do not send catalog keys to another service and
expect that service to know the application's dictionary.

Pass the resolved locale as notification metadata, not as a field in the
application payload. `render(data, context)` and `email(data, context)` receive
the same canonical `context.locale`:

```ts
render: ({ itemName }, { locale }) => messages.resolve([locale]).t.ready({ itemName }),

await notifications.send(app.notifications.itemReady, {
  recipient: { userId },
  data: { itemName },
  idempotencyKey,
  locale: getLocale(c),
});
```

Background work without a request must deliberately pass its persisted locale
or the operator's `app.locale` default.

## Test locale behavior

At minimum, verify:

1. Base-locale output and one translated locale;
2. Regional fallback such as `de-CH` to `de`, plus fallback to the base per key;
3. Concurrent SSR requests with different locales do not leak into each other;
4. Server HTML and the browser island format the same initial value;
5. Numeric, date, time, plural, and list output at the owner seam;
6. Stable error codes with localized human messages;
7. Capability, widget, Help, job, or notification transport when the feature
   crosses that boundary.

Use exact semantic assertions where possible. For `Intl` output, compare with
the runtime formatter for the requested locale instead of hardcoding grouping
characters that may be Unicode punctuation.

Run `bun run check:localization` for repository-wide catalog structure. It
requires every shipped `i18n.define()` catalog to declare inline English and
German message objects with matching keys and rejects German catalogs that
inherit English presentation through an object spread. Technical terms may
remain identical when the owning catalog declares them explicitly.

## Review checklist

- No process-global current locale.
- No locale props threaded through ordinary component trees.
- No message keys exposed in APIs, capabilities, widgets, or stored events.
- No branching on translated errors.
- No hardcoded locale at formatting seams.
- No duplicated component or route per language.
- No application-owned locale picker or competing browser preference.
