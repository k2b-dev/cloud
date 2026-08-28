import { type DateContext, dates, i18n } from "@k2b/stdlib";
import type { Recurrence } from "../contracts";

export type RecurrencePreset = "never" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";
export type RecurrenceEndMode = "never" | "on" | "after";

export type RecurrenceFormState = {
  preset: RecurrencePreset;
  frequency: RecurrenceFrequency;
  interval: number;
  byDay: string[];
  endMode: RecurrenceEndMode;
  until: string;
  count: number | null;
};

export type RecurrenceSummaryOptions = {
  startsAt?: string | null;
  allDay?: boolean;
  dateConfig?: DateContext;
};

const FREQ_TO_PRESET: Record<string, RecurrencePreset> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};

const PRESET_TO_FREQ: Record<Exclude<RecurrencePreset, "never">, string> = {
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  yearly: "YEARLY",
  custom: "WEEKLY",
};

export const recurrenceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      doesNotRepeat: "Does not repeat",
      singleEvent: "Single event only.",
      daily: "Daily",
      dailyDescription: "Repeats every day.",
      weekly: "Weekly",
      weeklyDescription: "Repeats on this weekday.",
      monthly: "Monthly",
      monthlyDescription: "Repeats on this day of the month.",
      yearly: "Yearly",
      yearlyDescription: "Repeats on this date each year.",
      custom: "Custom",
      customDescription: "Choose frequency and interval.",
      everyNDays: "Every N days.",
      everyNWeeks: "Every N weeks.",
      everyNMonths: "Every N months.",
      everyNYears: "Every N years.",
      noEnd: "No end",
      noEndDescription: "Continues until changed.",
      onDate: "On date",
      onDateDescription: "Stops after a date.",
      afterCount: "After count",
      afterCountDescription: "Stops after the selected number of occurrences.",
      every: ({ value }: { value: string; frequency: RecurrenceFrequency; interval: number }) => `Repeats every ${value}`,
      everyOn: ({ value, weekdays }: { value: string; weekdays: string; frequency: RecurrenceFrequency; interval: number }) =>
        `Repeats every ${value} on ${weekdays}`,
      everyWeekdays: ({ weekdays }: { weekdays: string }) => `Repeats every ${weekdays}`,
      onDay: ({ day }: { day: string }) => ` on day ${day}`,
      annuallyOnDate: ({ date }: { date: string }) => ` on ${date}`,
      at: ({ time }: { time: string }) => ` at ${time}`,
      until: ({ date }: { date: string }) => ` until ${date}`,
      occurrences: ({ count }: { count: number }) => ` for ${count} ${count === 1 ? "occurrence" : "occurrences"}`,
    },
    de: {
      doesNotRepeat: "Keine Wiederholung",
      singleEvent: "Ein einzelner Termin.",
      daily: "Täglich",
      dailyDescription: "Wird jeden Tag wiederholt.",
      weekly: "Wöchentlich",
      weeklyDescription: "Wird an diesem Wochentag wiederholt.",
      monthly: "Monatlich",
      monthlyDescription: "Wird an diesem Tag des Monats wiederholt.",
      yearly: "Jährlich",
      yearlyDescription: "Wird jedes Jahr an diesem Datum wiederholt.",
      custom: "Benutzerdefiniert",
      customDescription: "Häufigkeit und Abstand festlegen.",
      everyNDays: "Alle N Tage.",
      everyNWeeks: "Alle N Wochen.",
      everyNMonths: "Alle N Monate.",
      everyNYears: "Alle N Jahre.",
      noEnd: "Ohne Ende",
      noEndDescription: "Wird wiederholt, bis die Serie geändert wird.",
      onDate: "An einem Datum",
      onDateDescription: "Endet nach dem ausgewählten Datum.",
      afterCount: "Nach einer Anzahl",
      afterCountDescription: "Endet nach der ausgewählten Anzahl von Terminen.",
      every: ({ value, frequency, interval }) =>
        interval > 1
          ? `Wiederholt sich alle ${value}`
          : frequency === "daily"
            ? "Wiederholt sich jeden Tag"
            : frequency === "weekly"
              ? "Wiederholt sich jede Woche"
              : frequency === "monthly"
                ? "Wiederholt sich jeden Monat"
                : "Wiederholt sich jedes Jahr",
      everyOn: ({ value, weekdays, frequency, interval }) =>
        frequency === "weekly" && interval === 1
          ? `Wiederholt sich jeden ${weekdays}`
          : `Wiederholt sich ${interval > 1 ? `alle ${value}` : frequency === "daily" ? "jeden Tag" : frequency === "monthly" ? "jeden Monat" : "jedes Jahr"} am ${weekdays}`,
      everyWeekdays: ({ weekdays }) => `Wiederholt sich jeden ${weekdays}`,
      onDay: ({ day }) => ` am ${day}.`,
      annuallyOnDate: ({ date }) => ` am ${date}`,
      at: ({ time }) => ` um ${time} Uhr`,
      until: ({ date }) => ` bis ${date}`,
      occurrences: ({ count }) => ` für ${count} ${count === 1 ? "Termin" : "Termine"}`,
    },
  },
});

const recurrenceText = (dateConfig?: DateContext) => recurrenceMessages.resolve(dateConfig?.locale ? [dateConfig.locale] : []).t;

export const weekdayOptions = (dateConfig?: DateContext) => {
  const ids = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
  const context = { ...dateConfig, timeZone: dateConfig?.timeZone ?? "UTC" };
  const monday = new Date("2024-01-01T12:00:00Z");
  return ids.map((id, index) => {
    const date = dates.addDays(monday, index, context);
    const fullLabel = dates.formatWeekdayLong(date, context);
    return { id, label: fullLabel.slice(0, 1), fullLabel };
  });
};

export const recurrencePresetOptions = (dateConfig?: DateContext) => {
  const t = recurrenceText(dateConfig);
  return [
    { id: "never", label: t.doesNotRepeat, description: t.singleEvent, icon: "ti ti-calendar-event" },
    { id: "daily", label: t.daily, description: t.dailyDescription, icon: "ti ti-repeat" },
    { id: "weekly", label: t.weekly, description: t.weeklyDescription, icon: "ti ti-calendar-week" },
    { id: "monthly", label: t.monthly, description: t.monthlyDescription, icon: "ti ti-calendar-month" },
    { id: "yearly", label: t.yearly, description: t.yearlyDescription, icon: "ti ti-calendar" },
    { id: "custom", label: t.custom, description: t.customDescription, icon: "ti ti-adjustments" },
  ];
};

export const recurrenceFrequencyOptions = (dateConfig?: DateContext) => {
  const t = recurrenceText(dateConfig);
  return [
    { id: "daily", label: t.daily, description: t.everyNDays, icon: "ti ti-repeat" },
    { id: "weekly", label: t.weekly, description: t.everyNWeeks, icon: "ti ti-calendar-week" },
    { id: "monthly", label: t.monthly, description: t.everyNMonths, icon: "ti ti-calendar-month" },
    { id: "yearly", label: t.yearly, description: t.everyNYears, icon: "ti ti-calendar" },
  ];
};

export const recurrenceEndOptions = (dateConfig?: DateContext) => {
  const t = recurrenceText(dateConfig);
  return [
    { id: "never", label: t.noEnd, description: t.noEndDescription, icon: "ti ti-infinity" },
    { id: "on", label: t.onDate, description: t.onDateDescription, icon: "ti ti-calendar-due" },
    { id: "after", label: t.afterCount, description: t.afterCountDescription, icon: "ti ti-list-numbers" },
  ];
};

export const emptyRecurrenceState = (): RecurrenceFormState => ({
  preset: "never",
  frequency: "weekly",
  interval: 1,
  byDay: [],
  endMode: "never",
  until: "",
  count: null,
});

const parseRrule = (rrule: string) =>
  Object.fromEntries(
    rrule
      .split(";")
      .map((part) => part.split("="))
      .filter((part): part is [string, string] => Boolean(part[0] && part[1]))
      .map(([key, value]) => [key.toUpperCase(), value]),
  );

export const recurrenceToFormState = (recurrence: Recurrence | null | undefined, dateConfig?: DateContext): RecurrenceFormState => {
  if (!recurrence?.rrule) return emptyRecurrenceState();
  const parts = parseRrule(recurrence.rrule);
  const frequency = (FREQ_TO_PRESET[parts.FREQ ?? ""] ?? "weekly") as RecurrenceFrequency;
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  const byDay = parts.BYDAY?.split(",").filter(Boolean) ?? [];
  const preset = interval > 1 || byDay.length > 0 ? "custom" : frequency;
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  return {
    preset,
    frequency,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
    byDay,
    endMode: parts.UNTIL ? "on" : count ? "after" : "never",
    until: parts.UNTIL ? untilToDateInput(parts.UNTIL, dateConfig) : "",
    count: count && Number.isFinite(count) ? count : null,
  };
};

export const recurrenceFromFormState = (state: RecurrenceFormState, startsAt: string, dateConfig?: DateContext): Recurrence | null => {
  if (state.preset === "never") return null;
  const freq = state.preset === "custom" ? PRESET_TO_FREQ[state.frequency] : PRESET_TO_FREQ[state.preset];
  const parts = [`FREQ=${freq}`];
  if (state.preset === "custom" && state.interval > 1) parts.push(`INTERVAL=${Math.floor(state.interval)}`);
  if (state.preset === "custom" && state.frequency === "weekly" && state.byDay.length > 0) parts.push(`BYDAY=${state.byDay.join(",")}`);
  if (state.endMode === "on" && state.until) parts.push(`UNTIL=${dateInputToUntil(state.until, dateConfig)}`);
  if (state.endMode === "after" && state.count && state.count > 0) parts.push(`COUNT=${Math.floor(state.count)}`);
  return { rrule: parts.join(";"), dtstart: startsAt ? new Date(startsAt).toISOString() : null, exdate: [] };
};

const validDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatStartTime = (value: string | null | undefined, date: Date, dateConfig?: DateContext): string => {
  const localTime = dateConfig?.timeZone ? undefined : value?.match(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/)?.[1];
  return localTime ?? dates.formatTime(date, dateConfig);
};

const dateInputInstant = (value: string, dateConfig?: DateContext): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  try {
    return new Date(
      dateConfig?.timeZone
        ? dates.zonedDateTimeToInstant(`${value}T12:00:00`, dateConfig.timeZone, { disambiguation: "compatible" })
        : `${value}T12:00:00.000Z`,
    );
  } catch {
    return null;
  }
};

export const summarizeRecurrenceState = (state: RecurrenceFormState, options: RecurrenceSummaryOptions = {}): string | null => {
  if (state.preset === "never") return null;
  const startsAt = validDate(options.startsAt);
  const t = recurrenceText(options.dateConfig);
  const until = state.endMode === "on" ? dateInputInstant(state.until, options.dateConfig) : null;
  const weekdayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const byWeekday = state.byDay.map((day) => weekdayMap[day]).filter((day): day is number => day !== undefined);
  if (state.frequency === "weekly" && byWeekday.length === 0 && startsAt) byWeekday.push(startsAt.getUTCDay());
  const parts = dates.formatRecurrenceParts(
    {
      freq: state.frequency,
      interval: Math.max(1, Math.floor(state.interval)),
      ...(byWeekday.length > 0 ? { byWeekday } : {}),
      ...(until ? { until } : {}),
      ...(state.endMode === "after" && state.count ? { count: state.count } : {}),
    },
    options.dateConfig,
  );
  const interval = Math.max(1, Math.floor(state.interval));
  const longWeekdays = i18n.formatList(
    state.byDay.map((day) => weekdayOptions(options.dateConfig).find((option) => option.id === day)?.fullLabel ?? day),
    options.dateConfig?.locale,
  );
  let base =
    state.frequency === "weekly" && interval === 1 && (longWeekdays || startsAt)
      ? t.everyWeekdays({ weekdays: longWeekdays || dates.formatWeekdayLong(startsAt!, options.dateConfig) })
      : parts.weekdays
        ? t.everyOn({ value: parts.every, weekdays: parts.weekdays, frequency: state.frequency, interval })
        : t.every({ value: parts.every, frequency: state.frequency, interval });
  if (state.frequency === "monthly" && startsAt) base += t.onDay({ day: dates.formatDayNumber(startsAt, options.dateConfig) });
  if (state.frequency === "yearly" && startsAt) {
    const date = new Intl.DateTimeFormat(options.dateConfig?.locale ?? "en", {
      day: "numeric",
      month: "long",
      timeZone: options.dateConfig?.timeZone ?? "UTC",
    }).format(startsAt);
    base += t.annuallyOnDate({ date });
  }
  const time = !options.allDay && startsAt ? t.at({ time: formatStartTime(options.startsAt, startsAt, options.dateConfig) }) : "";
  const end = parts.until
    ? t.until({
        date: `${new Intl.DateTimeFormat(options.dateConfig?.locale ?? "en", {
          weekday: "short",
          timeZone: options.dateConfig?.timeZone ?? "UTC",
        }).format(until!)} ${parts.until}`,
      })
    : parts.count
      ? t.occurrences({ count: parts.count })
      : "";
  return `${base}${time}${end}`;
};

export const summarizeRecurrence = (recurrence: Recurrence | null | undefined, options: RecurrenceSummaryOptions = {}): string | null =>
  summarizeRecurrenceState(recurrenceToFormState(recurrence, options.dateConfig), options);

const compactUtc = (date: Date): string =>
  `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}T${String(
    date.getUTCHours(),
  ).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}Z`;

const untilToDateInput = (until: string, dateConfig?: DateContext): string => {
  if (/^\d{8}/.test(until)) return `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  const date = new Date(until);
  return Number.isNaN(date.getTime()) ? "" : dates.formatDateKey(date, dateConfig);
};

const dateInputToUntil = (value: string, dateConfig?: DateContext): string => {
  if (dateConfig?.timeZone) {
    return compactUtc(new Date(dates.zonedDateTimeToInstant(`${value}T23:59:59`, dateConfig.timeZone, { disambiguation: "compatible" })));
  }
  return compactUtc(new Date(`${value}T23:59:59.999Z`));
};
