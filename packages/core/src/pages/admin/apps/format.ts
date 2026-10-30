import { formatDate, formatDateTime, formatDurationMs, formatNumber, formatPercent } from "@k2b/cloud/shared";
import { type DateContext, dates } from "@k2b/stdlib";

/** The page's formatters in the request's locale and timezone; the server renders every value once. */
export const appsFormat = (context: DateContext, now = Date.now()) => {
  const sameDay = (value: string) => dates.formatDate(value, context) === dates.formatDate(new Date(now).toISOString(), context);
  return {
    locale: context.locale ?? "en",
    number: (value: number) => formatNumber(value, { locale: context.locale }),
    percent: (ratio: number) => formatPercent(ratio, { locale: context.locale, decimals: 1 }),
    ms: (value: number) => formatDurationMs(value, { locale: context.locale }),
    date: (value: string) => formatDate(value, context),
    dateTime: (value: string) => formatDateTime(value, context),
    /** A time today, otherwise the date: "14:02" or "14.09.2026". */
    moment: (value: string) => (sameDay(value) ? dates.formatTime(value, context) : formatDate(value, context)),
    relative: (value: string) => dates.formatTimeSpan(value, { ...context, base: new Date(now) }),
  };
};
export type AppsFormat = ReturnType<typeof appsFormat>;

/**
 * The provider values of the app page's "Traffic 24 h" and "Errors" rows, as the server renders them and as "Try again"
 * refreshes them. `traffic: null` from a provider means no measurements, never zero requests.
 */
export const providerValues = (
  t: {
    trafficValue: (p: { requests: string; rate: string; ms: string | null }) => string;
    noMeasurements: string;
    errorsValue: (p: { count: number }) => string;
  },
  f: AppsFormat,
  numbers: ReadonlyArray<{ traffic: { requests: number; errors: number; avgMs: number | null } | null }>,
  unavailable: boolean,
) => {
  const traffic = numbers.find((entry) => entry.traffic)?.traffic ?? null;
  const measured = numbers.length > 0;
  return {
    traffic: traffic
      ? t.trafficValue({
          requests: f.number(traffic.requests),
          rate: f.percent(traffic.requests ? traffic.errors / traffic.requests : 0),
          ms: traffic.avgMs !== null ? f.ms(traffic.avgMs) : null,
        })
      : measured || !unavailable
        ? t.noMeasurements
        : null,
    errors: traffic ? t.errorsValue({ count: traffic.errors }) : measured || !unavailable ? t.noMeasurements : null,
    errorsTone: traffic && traffic.requests > 0 && traffic.errors / traffic.requests >= 0.01 ? ("danger" as const) : undefined,
    unavailable: unavailable && !traffic,
  };
};
