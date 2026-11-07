import type { DateContext } from "@k2b/stdlib";
import { chatMessages } from "../messages";

/** One conversation and date context own these formatters and weakly held message values. */
export const createMessageDates = (context: DateContext) => {
  // Time and calendar keys have always used Gregorian digits and a 24-hour clock, independently of label locale.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: context.timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = new WeakMap<{ at: string }, { at: string; time: string; dayKey: string }>();
  const read = (item: { at: string }) => {
    const cached = values.get(item);
    if (cached?.at === item.at) return cached;
    const fields = parts.formatToParts(new Date(item.at));
    const part = (type: Intl.DateTimeFormatPartTypes) => fields.find((field) => field.type === type)!.value;
    const value = { at: item.at, time: `${part("hour")}:${part("minute")}`, dayKey: `${part("year")}-${part("month")}-${part("day")}` };
    values.set(item, value);
    return value;
  };
  let current: { at: string; dayKey: string } | undefined;
  const labels = new Map<string, Intl.DateTimeFormat>();
  const label = (item: { at: string }, now: Date) => {
    const at = now.toISOString();
    if (current?.at !== at) current = { at, dayKey: read({ at }).dayKey };
    const key = read(item).dayKey;
    // Calendar-day subtraction preserves labels on 23- and 25-hour DST days.
    const days = (Date.parse(current.dayKey) - Date.parse(key)) / 86_400_000;
    const t = chatMessages.resolve(context.locale ? [context.locale] : []).t;
    if (days === 0) return t.today;
    if (days === 1) return t.yesterday;
    const mode = days >= 2 && days <= 6 ? "weekday" : key.slice(0, 4) === current.dayKey.slice(0, 4) ? "date" : "year";
    let formatter = labels.get(mode);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(context.locale ?? "en", {
        timeZone: context.timeZone,
        ...(mode === "weekday" ? { weekday: "long" } : { day: "numeric", month: "long", ...(mode === "year" ? { year: "numeric" } : {}) }),
      });
      labels.set(mode, formatter);
    }
    return formatter.format(new Date(item.at));
  };
  return { read, label };
};
