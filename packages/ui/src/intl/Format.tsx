import { type ByteMode, dates, text } from "@k2b/stdlib";
import { type JSX, Show, splitProps } from "solid-js";
import { useLocale } from "./locale";

const FALLBACK = "—";

type SpanProps = JSX.HTMLAttributes<HTMLSpanElement>;
// Temporal components render `<time>` for valid values and a `<span>` fallback
// otherwise, so their native attributes are typed against the shared element
// base; `ref` is excluded because its value form is element-specific. The
// `datetime` attribute is owned by the component itself.
type TimeElementProps = Omit<JSX.HTMLAttributes<HTMLElement>, "ref">;

type LocaleProp = {
  /** Explicit locale override; defaults to the inherited render locale. */
  locale?: string;
};

type FallbackProp = {
  /** Text rendered for null or invalid input. Defaults to `"—"`. */
  fallback?: string;
};

export type FormatNumberProps = SpanProps &
  LocaleProp &
  FallbackProp & {
    value: number | null | undefined;
    /** Use deterministic compact suffixes (`k`, `M`, `B`, `T`). */
    compact?: boolean;
    /** Fixed fraction digits. */
    decimals?: number;
  };

export type FormatPercentProps = SpanProps &
  LocaleProp &
  FallbackProp & {
    /** Ratio input: `0.12` renders as `12%`. */
    value: number | null | undefined;
    /** Fixed fraction digits. Defaults to 0. */
    decimals?: number;
    /** Clamp the ratio to 0..1 before formatting. */
    clamp?: boolean;
  };

export type FormatCurrencyProps = SpanProps &
  LocaleProp &
  FallbackProp & {
    value: number | null | undefined;
    /** ISO 4217 currency code, e.g. `"EUR"` or `"USD"`. */
    currency: string;
    /** Fixed fraction digits. Defaults to the currency's standard digits. */
    decimals?: number;
  };

export type FormatBytesProps = SpanProps &
  LocaleProp &
  FallbackProp & {
    value: number | null | undefined;
    /** `"iec"` (default, 1024-base) or `"si"` (1000-base). */
    mode?: ByteMode;
  };

export type FormatDateProps = TimeElementProps &
  LocaleProp &
  FallbackProp & {
    value: Date | string | null | undefined;
    /** IANA timezone. Defaults to `"UTC"` so server and browser text agree. */
    timeZone?: string;
  };

export type FormatTimeProps = FormatDateProps;
export type FormatDateTimeProps = FormatDateProps;

export type FormatRelativeTimeProps = TimeElementProps &
  LocaleProp &
  FallbackProp & {
    value: Date | string | null | undefined;
    /** Deterministic base timestamp; defaults to now. */
    base?: Date | string;
  };

export type FormatDurationProps = TimeElementProps &
  LocaleProp &
  FallbackProp & {
    from: Date | string | null | undefined;
    to: Date | string | null | undefined;
  };

export type FormatDurationMsProps = TimeElementProps &
  LocaleProp &
  FallbackProp & {
    /** Duration in milliseconds. */
    value: number | null | undefined;
  };

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (value == null) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
};

/** ISO 8601 duration for the `<time datetime>` attribute, e.g. `"PT2H30M"`. */
const isoDuration = (ms: number): string => {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds <= 0) return "PT0S";
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const time = `${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${seconds ? `${seconds}S` : ""}`;
  return `P${days ? `${days}D` : ""}${time ? `T${time}` : ""}`;
};

const FormatNumber = (props: FormatNumberProps): JSX.Element => {
  const [own, rest] = splitProps(props, ["value", "locale", "compact", "decimals", "fallback"]);
  const locale = useLocale();
  return (
    <span {...rest}>
      {text.pprintNumber(own.value, {
        locale: own.locale ?? locale(),
        compact: own.compact,
        decimals: own.decimals,
        fallback: own.fallback,
      })}
    </span>
  );
};

const FormatPercent = (props: FormatPercentProps): JSX.Element => {
  const [own, rest] = splitProps(props, ["value", "locale", "decimals", "clamp", "fallback"]);
  const locale = useLocale();
  return (
    <span {...rest}>
      {text.pprintPercent(own.value, {
        locale: own.locale ?? locale(),
        decimals: own.decimals,
        clamp: own.clamp,
        fallback: own.fallback,
      })}
    </span>
  );
};

const FormatCurrency = (props: FormatCurrencyProps): JSX.Element => {
  const [own, rest] = splitProps(props, ["value", "currency", "locale", "decimals", "fallback"]);
  const locale = useLocale();
  return (
    <span {...rest}>
      {text.pprintCurrency(own.value, own.currency, {
        locale: own.locale ?? locale(),
        decimals: own.decimals,
        fallback: own.fallback,
      })}
    </span>
  );
};

const FormatBytes = (props: FormatBytesProps): JSX.Element => {
  const [own, rest] = splitProps(props, ["value", "locale", "mode", "fallback"]);
  const locale = useLocale();
  return (
    <span {...rest}>
      {typeof own.value === "number" && Number.isFinite(own.value)
        ? text.pprintBytes(own.value, { locale: own.locale ?? locale(), mode: own.mode })
        : (own.fallback ?? FALLBACK)}
    </span>
  );
};

type TemporalFormatter = (date: Date, context: { locale: string; timeZone: string }) => string;

const temporalComponent =
  (format: TemporalFormatter) =>
  (props: FormatDateProps): JSX.Element => {
    const [own, rest] = splitProps(props, ["value", "locale", "timeZone", "fallback"]);
    const locale = useLocale();
    return (
      <Show when={toDate(own.value)} fallback={<span {...rest}>{own.fallback ?? FALLBACK}</span>}>
        {(date) => (
          <time {...rest} datetime={date().toISOString()}>
            {format(date(), { locale: own.locale ?? locale(), timeZone: own.timeZone ?? "UTC" })}
          </time>
        )}
      </Show>
    );
  };

const FormatDate = temporalComponent((date, context) => dates.formatDate(date, context));
const FormatTime = temporalComponent((date, context) => dates.formatTime(date, context));
const FormatDateTime = temporalComponent((date, context) => dates.formatDateTime(date, context));

const FormatRelativeTime = (props: FormatRelativeTimeProps): JSX.Element => {
  const [own, rest] = splitProps(props, ["value", "locale", "base", "fallback"]);
  const locale = useLocale();
  return (
    <Show when={toDate(own.value)} fallback={<span {...rest}>{own.fallback ?? FALLBACK}</span>}>
      {(date) => (
        <time {...rest} datetime={date().toISOString()}>
          {dates.formatTimeSpan(date(), { locale: own.locale ?? locale(), base: own.base })}
        </time>
      )}
    </Show>
  );
};

const FormatDuration = (props: FormatDurationProps): JSX.Element => {
  const [own, rest] = splitProps(props, ["from", "to", "locale", "fallback"]);
  const locale = useLocale();
  const range = () => {
    const from = toDate(own.from);
    const to = toDate(own.to);
    return from && to ? { from, to } : null;
  };
  return (
    <Show when={range()} fallback={<span {...rest}>{own.fallback ?? FALLBACK}</span>}>
      {(value) => (
        <time {...rest} datetime={isoDuration(Math.abs(value().to.getTime() - value().from.getTime()))}>
          {dates.formatDuration(value().from, value().to, { locale: own.locale ?? locale() })}
        </time>
      )}
    </Show>
  );
};

const FormatDurationMs = (props: FormatDurationMsProps): JSX.Element => {
  const [own, rest] = splitProps(props, ["value", "locale", "fallback"]);
  const locale = useLocale();
  // Wrapped in an object because a valid duration of 0ms is falsy.
  const valid = (): { ms: number } | null => {
    const value = own.value;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? { ms: value } : null;
  };
  return (
    <Show when={valid()} fallback={<span {...rest}>{own.fallback ?? FALLBACK}</span>}>
      {(duration) => (
        <time {...rest} datetime={isoDuration(duration().ms)}>
          {text.pprintDurationMs(duration().ms, { locale: own.locale ?? locale() })}
        </time>
      )}
    </Show>
  );
};

/**
 * Unstyled semantic formatter components backed by `@k2b/stdlib`.
 *
 * Numeric components render a plain `<span>`; date/time components render
 * `<time>` with a canonical `datetime` attribute. All components inherit the
 * render locale (see `LocaleProvider` / `useLocale`) and accept an explicit
 * `locale` override. Date, Time, and DateTime format in UTC unless an
 * explicit `timeZone` is given, so server and browser output never diverge
 * with the runtime timezone.
 */
export const Format = {
  Number: FormatNumber,
  Percent: FormatPercent,
  Currency: FormatCurrency,
  Bytes: FormatBytes,
  Date: FormatDate,
  Time: FormatTime,
  DateTime: FormatDateTime,
  RelativeTime: FormatRelativeTime,
  Duration: FormatDuration,
  DurationMs: FormatDurationMs,
} as const;
