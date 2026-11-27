import { type DateContext, dates } from "@k2b/stdlib";

export type PulseDateContext = DateContext & { now?: string | Date };

export const defaultPulseDateContext: PulseDateContext = {
  timeZone: "UTC",
  locale: "en",
  firstDayOfWeek: 1,
};

const dateContext = (context?: DateContext): DateContext => ({
  ...defaultPulseDateContext,
  ...(context ?? {}),
});

export const compactDate = (value: string, context?: DateContext) => {
  const resolved = dateContext(context);
  if (resolved.timeZone) return dates.instantToZonedInput(value, resolved.timeZone).slice(11, 16);
  return new Intl.DateTimeFormat(resolved.locale ?? "en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
};

export const compactDay = (value: string, context?: DateContext) => {
  const resolved = dateContext(context);
  return new Intl.DateTimeFormat(resolved.locale ?? "en", {
    timeZone: resolved.timeZone,
    month: "short",
    day: "2-digit",
  }).format(new Date(value));
};

/** A moment as its time when it is today in the zone, else as day and time, with how long ago: "10:41 (vor 1 Minute)". */
export const compactDateWithDelta = (value: string, context?: PulseDateContext) => {
  const resolved = dateContext(context);
  const now = context?.now ?? new Date();
  const zone = resolved.timeZone ?? "UTC";
  const today =
    dates.instantToZonedInput(value, zone).slice(0, 10) === dates.instantToZonedInput(new Date(now).toISOString(), zone).slice(0, 10);
  const at = today ? compactDate(value, resolved) : `${compactDay(value, resolved)} ${compactDate(value, resolved)}`;
  return `${at} (${dates.formatTimeSpan(value, { ...resolved, base: now })})`;
};
