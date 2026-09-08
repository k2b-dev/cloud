---
title: Locale and time
navTitle: Locale and time
section: Server
order: 240
description: Resolve the request locale and timezone once and reuse them for formatting, SSR, and capability metadata.
tags: [server, locale, timezone, i18n, formatting]
updated: 2026-08-27
---

# Locale and time

Every request carries one canonical locale and one timezone. Cloud resolves
both per request, keeps them separate, and never stores them in process-global
state, so concurrent requests with different preferences stay isolated.

The locale drives formatting, the document language, and the selection of
opt-in application message catalogs. It does not automatically translate
product copy. Applications opt in at the boundary that owns each message; see
[Internationalize an application](/en/docs/build/internationalization).

## Resolve the request locale

```ts
import { getDateConfig, getLocale } from "@k2b/cloud/server";

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
`canonicalLocale` from `@k2b/cloud/shared` canonicalize single tags.

Authenticated users can choose English or German from the shared profile menu.
Cloud writes the choice to the root-scoped `cloud.locale` cookie and reloads
the current page, so the next SSR response, `<html lang>`, formatters, islands,
widgets, Help, and capability calls all receive the same preference. The
preference is browser-local; it is not an account setting.

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
the same result. The document language is framework-owned: `<html lang>`, the
`LocaleProvider`, and `getDateConfig` always use the same canonical
`getLocale(c)`, and a page handler cannot override it.

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
import { invokeCapability } from "@k2b/cloud/capabilities/server";
import { getLocale } from "@k2b/cloud/server";

await invokeCapability(invocation, {
  cookie: request.headers.get("cookie"),
  locale: getLocale(c),
  signal: request.signal,
});
```

## Opt into message catalogs

Applications that want localized human-facing strings own their
`@k2b/stdlib` message catalog (`i18n.define`) and resolve it with the request
locale. The catalog owns regional fallback (`de-CH` falls back to `de`, then
the base locale); Cloud and capability callers never need to know an
application's message keys:

```ts
import { getLocale } from "@k2b/cloud/server";
import { messages } from "../i18n"; // the app-owned @k2b/stdlib catalog

router.get("/api/inventory", (c) => {
  const { t } = messages.resolve([getLocale(c)]);
  return c.json({ emptyMessage: t.emptyList });
});
```

The complete conventions for catalog placement, errors, SSR and islands,
capabilities, widgets, Help, notifications, email, and testing live in
[Internationalize an application](/en/docs/build/internationalization).

## Non-goals

This contract prepares internationalization without translating application
copy automatically:

- Cloud does not automatically translate existing product copy; stable error
  codes never change with the locale.
- The shared profile menu currently offers English and German. Applications do
  not own language selection and must not write a competing preference.
- Applications do not receive locale props through component trees; the
  document language and providers above own inheritance.

## Verify the boundary

Request two pages concurrently with different `Accept-Language` headers: each
response must carry its own `<html lang>`, provider locale, and date config.
Formatting seams must not hardcode a locale; if a value renders wrong for a
`de-CH` visitor, the seam is missing `getLocale` or `getDateConfig`.
