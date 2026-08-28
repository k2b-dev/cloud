import { type DateContext, dates } from "@k2b/stdlib";
import type { DatePreset, DateRangeValue, DurationPreset } from "@k2b/ui";
import { spaceMessages } from "../../../messages";

const pickerContext = (dateConfig?: DateContext): DateContext => ({ weekStartsOn: 1, ...dateConfig });

const dateKey = (date: Date | string, dateConfig?: DateContext) => dates.formatDateKey(date, pickerContext(dateConfig));

export const datePart = (value: string, dateConfig?: DateContext): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : dateKey(value, dateConfig);

export const instantFromLocalDateTime = (date: string, time: string, dateConfig?: DateContext): string => {
  const value = `${date}T${time}`;
  if (dateConfig?.timeZone) {
    return dates.zonedDateTimeToInstant(value, dateConfig.timeZone, { disambiguation: "compatible" });
  }
  return new Date(value).toISOString();
};

export const allDayStart = (date: string, dateConfig?: DateContext): string => instantFromLocalDateTime(date, "00:00", dateConfig);

export const allDayEnd = (date: string, dateConfig?: DateContext): string => {
  const nextDay = dates.addDays(dates.parseCalendarDate(date, pickerContext(dateConfig)), 1, pickerContext(dateConfig));
  return allDayStart(dateKey(nextDay, dateConfig), dateConfig);
};

const dateOnlyEndKey = (end: string, dateConfig?: DateContext): string => {
  const context = pickerContext(dateConfig);
  const endDate = new Date(end);
  const endKey = dateKey(endDate, context);
  const dayStart = dates.startOfDay(endDate, context);
  if (endDate.getTime() !== dayStart.getTime()) return endKey;
  return dateKey(dates.addDays(dates.parseCalendarDate(endKey, context), -1, context), context);
};

export const dateOnlyRange = (start: string, end: string, dateConfig?: DateContext): DateRangeValue => ({
  start: start ? dateKey(start, dateConfig) : null,
  end: end ? dateOnlyEndKey(end, dateConfig) : null,
});

export const scheduleDatePresets = (dateConfig?: DateContext): DatePreset<string | null>[] => {
  const { t } = spaceMessages.resolve(dateConfig?.locale ? [dateConfig.locale] : []);
  const context = pickerContext(dateConfig);
  const today = dates.today(context);
  const tomorrow = dates.addDays(today, 1, context);
  const nextWeek = dates.addWeeks(today, 1, context);
  return [
    { label: t.today, value: dateKey(today, context) },
    { label: t.tomorrow, value: dateKey(tomorrow, context) },
    { label: t.nextWeek, value: dateKey(nextWeek, context) },
  ];
};

export const EVENT_DURATION_PRESETS: DurationPreset[] = [
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "1.5h", minutes: 90 },
  { label: "2h", minutes: 120 },
  { label: "3h", minutes: 180 },
];

export const deadlinePresets = (dateConfig?: DateContext): DatePreset<string | null>[] => {
  const { t } = spaceMessages.resolve(dateConfig?.locale ? [dateConfig.locale] : []);
  const context = pickerContext(dateConfig);
  const todayDate = dates.today(context);
  const tomorrowDate = dates.addDays(todayDate, 1, context);
  const weekStart = dates.startOfWeek(todayDate, context);
  const friday = dates.addDays(weekStart, 4, context);
  return [
    { label: t.today, value: instantFromLocalDateTime(dateKey(todayDate, context), "17:00", context) },
    { label: t.tomorrow, value: instantFromLocalDateTime(dateKey(tomorrowDate, context), "17:00", context) },
    { label: t.endOfWeek, value: instantFromLocalDateTime(dateKey(friday, context), "17:00", context) },
  ];
};
