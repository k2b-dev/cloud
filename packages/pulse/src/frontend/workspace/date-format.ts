import { dates, type DateContext } from "@k2b/stdlib";

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

export const compactDateWithDelta = (value: string, context?: PulseDateContext) => {
  const resolved = dateContext(context);
  return `${compactDate(value, resolved)} (${dates.formatTimeSpan(value, { ...resolved, base: context?.now ?? new Date() })})`;
};
