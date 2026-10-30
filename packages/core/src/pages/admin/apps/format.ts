import { type DateContext, dates } from "@k2b/stdlib";
import { formatDate, formatDateTime, formatDurationMs, formatNumber, formatPercent } from "@k2b/cloud/shared";

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
