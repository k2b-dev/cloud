import { dates } from "@k2b/stdlib";
import { img } from "@k2b/stdlib/browser";
import type { DateRangeValue } from "@k2b/ui";
import type { DateOverride, OpeningRule, ShiftTemplate, UpcomingSlot, Venue } from "../../../contracts";

const MAX_BANNER_LONGEST_SIDE = 1600;

export const timeZoneDateConfig = (timeZone: string, locale?: string) => ({ timeZone, locale, weekStartsOn: 1 as const });
const QUARTER_HOUR_MS = 15 * 60_000;
/** `now` rounded up to the next quarter hour; every real time zone offset is a whole number of quarter hours. */
export const nextQuarterHour = (now: Date): Date => new Date(Math.ceil(now.getTime() / QUARTER_HOUR_MS) * QUARTER_HOUR_MS);
/** Free time starts at the next quarter hour and lasts two hours until someone changes it. */
export const defaultShiftRange = (now = new Date()): DateRangeValue => {
  const start = nextQuarterHour(now);
  return { start: start.toISOString(), end: new Date(start.getTime() + 2 * 60 * 60_000).toISOString() };
};
/** Slots in their given order, grouped by the local day (`date`) they take place. */
export const groupSlotsByDay = (slots: readonly UpcomingSlot[]): { date: string; slots: UpcomingSlot[] }[] => {
  const days: { date: string; slots: UpcomingSlot[] }[] = [];
  for (const slot of slots) {
    const last = days.at(-1);
    if (last?.date === slot.date) last.slots.push(slot);
    else days.push({ date: slot.date, slots: [slot] });
  }
  return days;
};
export const joinedSlot = (slot: UpcomingSlot, userId: string): boolean => slot.assignments.some((entry) => entry.userId === userId);

export const readError = async (res: Pick<Response, "json">, fallback: string): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

export const canWrite = (venue: Venue): boolean => venue.permission === "write" || venue.permission === "admin";
export const canAdmin = (venue: Venue): boolean => venue.permission === "admin";
export const isSlotActive = (slot: UpcomingSlot): boolean => new Date(slot.endsAt) >= new Date();
/** The day `date` falls on in the venue's time zone; the calendar's days start at local midnight, not in UTC. */
export const dateKey = (date: Date, timeZone: string): string => dates.formatDateKey(date, { timeZone });
/** Local midnight of `value` in the venue's time zone, the date the calendar shows; today for an invalid key. */
export const calendarDateOf = (value: string, timeZone: string): Date => dates.parseCalendarDate(value, { timeZone });
export const parseDateKey = (value: string): Date => {
  const parsed = new Date(value + "T12:00:00Z");
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};
export const sortOpeningRules = (rules: OpeningRule[]) =>
  [...rules].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
export const sortOverrides = (entries: DateOverride[]) => [...entries].sort((a, b) => a.date.localeCompare(b.date));
export const sortShiftTemplates = (templates: ShiftTemplate[]) =>
  [...templates].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
export const bannerTransform = async (file: File): Promise<string> => {
  const data = await img.create(file);
  const longest = Math.max(data.width, data.height);
  const scale = Math.min(1, MAX_BANNER_LONGEST_SIDE / longest);
  const next = scale < 1 ? await img.resize(Math.round(data.width * scale), Math.round(data.height * scale), "fill")(data) : data;
  return img.toBase64("webp", 0.85)(next);
};
