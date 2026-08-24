---
title: Locale and time
navTitle: Locale and time
section: Server
order: 240
description: Resolve the request locale and timezone once and reuse them for formatting, SSR, and capability metadata.
tags: [server, locale, timezone, i18n, formatting]
updated: 2026-08-24
---

# Locale and time

Every request carries one canonical locale and one timezone. Cloud resolves
both per request, keeps them separate, and never stores them in process-global
state, so concurrent requests with different preferences stay isolated.

The locale drives *formatting and document language only*. Cloud ships its
product copy untranslated; resolving a locale does not translate UI text,
validation messages, capability errors, help, notifications, or emails.

## Resolve the request locale

```ts
import { getDateConfig, getLocale } from "@valentinkolb/cloud/server";

router.get("/api/inventory/report", (c) => {
  const locale = getLocale(c); // e.g. "de-CH"
  const dateConfig = getDateConfig(c); // { timeZone, locale, firstDayOfWeek }
  return c.json({ heading: new Intl.DateTimeFormat(locale).format(new Date()) });
});
```

`getLocale(c)` resolves with deterministic precedence; the first valid BCP 47
tag wins and every candidate is canonicalized (`DE-ch` becomes `de-CH`,
regional tags such as `de-CH` stay intact):

1. `x-cloud-locale` request header — transport metadata set by Cloud-internal
   callers such as the capability dispatcher;
2. `cloud.locale` cookie — an explicit preference (`LOCALE_COOKIE`);
3. `Accept-Language`, in quality order;
4. the operator's `app.locale` setting;
5. `"en"` (`DEFAULT_LOCALE`).

Invalid tags fall through to the next source. Reading `app.locale` requires
the request snapshot from `middleware.settings()`; without a snapshot the
resolver still returns a deterministic value.

`resolveLocale(headers, operatorDefault?)` applies the same rules to plain
`Headers` outside a request context, and `preferredLocale(headers)` returns
only the caller's explicit preference (or `undefined`). `normalizeLocale` and
`canonicalLocale` from `@valentinkolb/cloud/shared` canonicalize single tags.

## Keep timezone separate

`getTimeZone(c)` resolves the viewer's timezone from the `cloud.timezone`
cookie, then the operator's `app.timezone` setting, then `"UTC"`. Locale and
timezone are independent values: a visitor in Zurich may read English pages in
`Europe/Zurich`, and a German-speaking visitor may live in `UTC`.

`getDateConfig(c)` combines both into the `DateContext` that `@k2b/stdlib`
date formatters and `@k2b/ui` date surfaces accept. Pass it instead of
hardcoding a locale:

```ts
import { dates } from "@k2b/stdlib";

dates.formatDateTime(item.updatedAt, getDateConfig(c));
```

## SSR pages and browser islands

For every page rendered through `app.ssr(...)`, the framework resolves the
request locale into `c.get("page").lang` and emits it as the document's
`<html lang>` attribute. The Cloud `Layout` wraps its children in the
`@k2b/ui` `LocaleProvider` with the same value, so server-rendered `@k2b/ui`
components format for the request locale without per-component props.

Browser islands are independent Solid roots: they inherit
`document.documentElement.lang` through `useLocale()` instead of requiring a
top-level island provider. Because `<html lang>` and the SSR provider carry
the same resolved locale, server and browser passes agree and reloads keep
the same result. A page may override the document language for one response
by setting `c.get("page").lang` in its handler.

## Locale as capability metadata

Capability invocations transport the locale as metadata next to authorization
and tracing — never inside a capability input schema or an auth token. The
Cloud dispatcher folds the caller's preference into the internal
`x-cloud-locale` header (`LOCALE_HEADER`); without a preference the header
stays absent and the provider falls back to the shared `app.locale` default.

Provider Query, Action, and review handlers receive the resolved value as
`context.locale` without declaring it in their input schemas. See
[Types, Queries & Actions](/en/docs/platform/capabilities) for the execution
context contract. Server-side callers with their own request context forward
it through the `locale` field of the capability caller:

```ts
import { invokeCapability } from "@valentinkolb/cloud/capabilities/server";
import { getLocale } from "@valentinkolb/cloud/server";

await invokeCapability(invocation, {
  cookie: request.headers.get("cookie"),
  locale: getLocale(c),
  signal: request.signal,
});
```

## Opt into message catalogs

Applications that want localized human-facing strings define a
`@k2b/stdlib` message catalog and resolve it with the request locale. The
catalog owns regional fallback (`de-CH` falls back to `de`, then the base
locale); Cloud and capability callers never need to know an application's
message keys:

```ts
import { i18n } from "@k2b/stdlib";
import { getLocale } from "@valentinkolb/cloud/server";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: { emptyList: "No items yet." },
    de: { emptyList: "Noch keine Einträge." },
  },
});

router.get("/api/inventory", (c) => {
  const { t } = catalog.resolve([getLocale(c)]);
  return c.json({ emptyMessage: t.emptyList });
});
```

## Non-goals

This contract prepares internationalization without introducing it:

- Cloud does not translate existing product copy, framework errors, help,
  notifications, or emails; stable error codes never change with the locale.
- There is no built-in language-picker UI. Honoring the `cloud.locale` cookie
  is the extension point for one.
- Applications do not receive locale props through component trees; the
  document language and providers above own inheritance.

## Verify the boundary

Request two pages concurrently with different `Accept-Language` headers: each
response must carry its own `<html lang>`, provider locale, and date config.
Formatting seams must not hardcode a locale; if a value renders wrong for a
`de-CH` visitor, the seam is missing `getLocale` or `getDateConfig`.
