# Locale and formatting

`LocaleProvider`, `useLocale()`, and the unstyled `Format` namespace make `@k2b/ui` components render numbers, currencies, and dates in one coherent locale without prop-drilling. Locale selection, user preferences, and message catalogs stay application-owned.

## Use LocaleProvider and Format

Use `Format` components wherever a value is displayed rather than edited: statistics, tables, timestamps, file sizes, and durations. They render semantic, unstyled elements, so the surrounding surface owns all styling.

Use `LocaleProvider` once near the SSR root to set the render locale. Use `useLocale()` in application components that need the effective locale for their own `Intl` calls.

Keep locale and timezone separate: the provider carries only the locale; date and time components take an explicit `timeZone` prop where it matters.

## Import

```tsx
import {
  Format,
  LocaleProvider,
  useLocale,
  type FormatCurrencyProps,
  type LocaleProviderProps,
} from "@k2b/ui";
```

## Locale resolution

Every locale-aware component resolves its locale in the same order:

1. an explicit component `locale` prop,
2. the nearest `LocaleProvider`,
3. the browser's `document.documentElement.lang`,
4. the deterministic default `"en"`.

On the server the provider is the only source, so SSR consumers wrap the page in `LocaleProvider` and emit a matching `<html lang>`. A browser island is an independent Solid root: an outer server-side provider does not survive the island's re-render, which falls back to `<html lang>` instead. Keeping both equal keeps server and browser text identical. Changing the language without a document reload is out of scope; update the preference and reload.

`NumberInput`, `DatePicker`, and `Calendar` inherit the same locale: the pickers prefer an explicit `dateConfig.locale`, and `NumberInput` derives its decimal separator from the effective locale while keeping its numeric value contract unchanged.

## Formatters

- `Format.Number` — grouped number, optional `compact` suffixes and fixed `decimals`.
- `Format.Percent` — ratio input (`0.12` renders `12%`), optional `clamp`.
- `Format.Currency` — requires an ISO 4217 `currency` code.
- `Format.Bytes` — IEC units by default, `mode="si"` for decimal units.
- `Format.Date`, `Format.Time`, `Format.DateTime` — render `<time>` with a canonical `datetime` attribute; format in UTC unless an explicit `timeZone` is given, so server and browser never disagree.
- `Format.RelativeTime` — relative wording with an optional deterministic `base`.
- `Format.Duration` — human-readable span between `from` and `to`.
- `Format.DurationMs` — compact duration from milliseconds.

Numeric components render a `<span>`; temporal components render `<time>`. Null and invalid input renders the `fallback` text (default `"—"`) in a `<span>`. Native attributes pass through to the rendered element.

## Accessibility

Temporal components expose the machine-readable instant through the `<time datetime>` attribute. The visible text is plain content, so screen readers announce the localized value directly. Fallback output is text, never an empty element.

## Runtime

All formatting runs through `Intl` and published `@k2b/stdlib` helpers; no translations ship with the package and no global state is mutated. The provider is request-local, so one server can render different locales concurrently.

## Example

```tsx
<LocaleProvider locale={requestLocale}>
  <p>
    <Format.Currency value={1999.5} currency="EUR" /> ·{" "}
    <Format.DateTime value={order.createdAt} timeZone="Europe/Berlin" /> ·{" "}
    <Format.RelativeTime value={order.updatedAt} />
  </p>
</LocaleProvider>
```
