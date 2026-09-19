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
- `Format.RelativeTime` — elapsed relative wording with an optional deterministic `base`.
- `Format.RelativeDate` — calendar-day wording for a strict `YYYY-MM-DD` value, such as “today”, “tomorrow”, or “3 days ago”.
- `Format.Duration` — human-readable span between `from` and `to`.
- `Format.DurationMs` — compact duration from milliseconds.

Numeric components render a `<span>`; temporal components render `<time>`. Null and invalid input renders the `fallback` text (default `"—"`) in a `<span>`. Native attributes pass through to the rendered element.

## API reference

```ts
type SpanProps = JSX.HTMLAttributes<HTMLSpanElement>;
type TimeElementProps = Omit<JSX.HTMLAttributes<HTMLElement>, "ref">;
type ByteMode = "iec" | "si";

type LocaleProviderProps = {
  locale: string; children?: JSX.Element;
};

type LocaleProp = {
  locale?: string;
};

type FallbackProp = {
  fallback?: string;
};

type FormatNumberProps = SpanProps &
  LocaleProp &
  FallbackProp & {
    value: number | null | undefined;
    compact?: boolean;
    decimals?: number;
  };

type FormatPercentProps = SpanProps &
  LocaleProp &
  FallbackProp & {
    value: number | null | undefined;
    decimals?: number;
    clamp?: boolean;
  };

type FormatCurrencyProps = SpanProps &
  LocaleProp &
  FallbackProp & {
    value: number | null | undefined;
    currency: string;
    decimals?: number;
  };

type FormatBytesProps = SpanProps &
  LocaleProp &
  FallbackProp & {
    value: number | null | undefined;
    mode?: ByteMode;
  };

type FormatDateProps = TimeElementProps &
  LocaleProp &
  FallbackProp & {
    value: Date | string | null | undefined;
    timeZone?: string;
  };

type FormatTimeProps = FormatDateProps;

type FormatDateTimeProps = FormatDateProps;

type FormatRelativeTimeProps = TimeElementProps &
  LocaleProp &
  FallbackProp & {
    value: Date | string | null | undefined;
    base?: Date | string;
    timeZone?: string;
  };

type FormatRelativeDateProps = TimeElementProps &
  LocaleProp &
  FallbackProp & {
    value: string | null | undefined;
    base?: Date | string;
    timeZone?: string;
  };

type FormatDurationProps = TimeElementProps &
  LocaleProp &
  FallbackProp & {
    from: Date | string | null | undefined;
    to: Date | string | null | undefined;
  };

type FormatDurationMsProps = TimeElementProps &
  LocaleProp &
  FallbackProp & {
    value: number | null | undefined;
  };
```

`SpanProps` means native `JSX.HTMLAttributes<HTMLSpanElement>`. `TimeElementProps` means native HTML attributes without `ref`; the formatter owns `datetime`. `ByteMode` is `"iec" | "si"`. `LocaleProp` and `FallbackProp` name shared shapes in this reference, not additional component exports.

`Format.Percent.decimals` defaults to 0 and `clamp` to false. Currency decimals default to the currency's standard digits. Dates accept `Date` or a parseable string; prefer explicit offset-bearing instants. `Format.RelativeTime.base` defaults to now; supply the same base for deterministic server/browser output. `Format.Duration` takes from/to instants, whereas DurationMs takes a number of milliseconds.

## Calendar-relative dates

Use `Format.RelativeDate` for date-only deadlines or scheduled days. It compares
Gregorian calendar dates, not elapsed 24-hour periods: tomorrow remains tomorrow
across daylight-saving changes. The value must be a real `YYYY-MM-DD` date
(years 0001–9999). It is never shifted by the timezone.

The optional `base` accepts a calendar date, a valid `Date`, or an ISO timestamp
with an explicit `Z` or `±HH:MM` offset. For an instant, `timeZone` determines
which calendar day it represents; the default is UTC. A date-only base already
names its calendar day. Invalid dates, timestamps without an offset, and
invalid zones render the fallback. Locale wording uses `Intl.RelativeTimeFormat`
with `numeric: "auto"`; it can include locale-specific labels such as “übermorgen”.
The formatter never decides whether a date is overdue or assigns a warning tone.

Pass the same base snapshot to SSR and the browser. An omitted base reads the
current time when the formatter evaluates; it does not install a timer. The
application owns refreshing a reactive base at day rollover or on resume. Share
one base across a list instead of giving every cell a timer.

Pair it with the absolute date so the reader retains context. Keep the absolute
date in UTC when formatting a date-only string with `Format.Date`:

```tsx
<Format.Date value="2026-09-17" />{ " (" }
<Format.RelativeDate
  value="2026-09-17"
  base="2026-09-16T22:30:00Z"
  timeZone="Europe/Berlin"
/>{ ")" }
```

## Date and locale options

Calendar and date-picker `dateConfig` use the public `DateContext` type:

```ts
type DateContext = {
  timeZone?: string;
  locale?: string;
  weekStartsOn?: 0 | 1;
  firstDayOfWeek?: 0 | 1;
};
```

`timeZone` is an IANA zone; `locale` is a BCP 47 tag. `firstDayOfWeek` wins over
its `weekStartsOn` alias (0 = Sunday, 1 = Monday, default Monday). Date pickers
and Calendar inherit an omitted locale; Format date components default to UTC.
Set an explicit timezone when a calendar or picker must show the same civil
time on machines in different zones.

## Accessibility

Temporal components expose the machine-readable instant through the `<time datetime>` attribute. `Format.RelativeDate` preserves the date-only value in that attribute. The visible text is plain content, so screen readers announce the localized value directly. Fallback output is text, never an empty element.

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
