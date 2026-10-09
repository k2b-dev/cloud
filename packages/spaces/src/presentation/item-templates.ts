import { dates, i18n } from "@k2b/stdlib";
import {
  MAX_ITEM_DESCRIPTION_LENGTH,
  MAX_ITEM_TITLE_LENGTH,
  type Priority,
  type SpaceItemTemplate,
  type TemplateDateRule,
  type TemplateWeekday,
} from "../contracts";

/**
 * Item templates turn into create requests here, for the browser, the API, capabilities, and `cld` alike. Everything
 * works on local calendar dates (`YYYY-MM-DD`) in the person's time zone and only becomes an instant at the end, so
 * week, month, and daylight-saving boundaries cannot move a proposed day.
 */

export const DEFAULT_TASK_TEMPLATE_TIME = "17:00";
export const DEFAULT_EVENT_TEMPLATE_TIME = "09:00";
export const DEFAULT_EVENT_TEMPLATE_DURATION_MINUTES = 60;
export const TEMPLATE_PROPOSAL_COUNT = 3;
export const TEMPLATE_PLACEHOLDERS = ["date", "weekday", "week"] as const;

/** The template fields a draft needs; tags and assignees arrive as IDs so one function serves public and internal IDs. */
export type TemplateDraftSource = Pick<
  SpaceItemTemplate,
  | "kind"
  | "title"
  | "description"
  | "priority"
  | "assignCreator"
  | "checklist"
  | "estimatedDurationMinutes"
  | "location"
  | "url"
  | "allDay"
  | "durationMinutes"
  | "timeOfDay"
  | "dateRule"
> & { tagIds: string[]; assigneeIds: string[] };

type TemplateTiming = Pick<SpaceItemTemplate, "kind" | "allDay" | "timeOfDay" | "dateRule">;

export type TemplateItemDraft = {
  title: string;
  description?: string;
  priority?: Priority;
  tagIds: string[];
  assigneeIds: string[];
  assignCreator: boolean;
  checklist: string[];
  deadline?: string;
  estimatedDurationMinutes?: number;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  location?: string;
  url?: string;
};

const WEEKDAY_INDEX: Record<TemplateWeekday, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WEEKDAY_ORDER: TemplateWeekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      noDate: "No date",
      today: "Today",
      inDays: ({ days }: { days: number }) => (days === 1 ? "In 1 day" : `In ${days} days`),
      allDay: "all day",
    },
    de: {
      noDate: "Ohne Datum",
      today: "Heute",
      inDays: ({ days }) => (days === 1 ? "In 1 Tag" : `In ${days} Tagen`),
      allDay: "ganztägig",
    },
  },
});

// ---------- Calendar dates ----------

const civil = (date: string): Date => new Date(`${date}T12:00:00Z`);
const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

/** Adds whole calendar days to a local date; independent of any time zone. */
export const addCalendarDays = (date: string, days: number): string => {
  const next = civil(date);
  next.setUTCDate(next.getUTCDate() + days);
  return dateKey(next);
};

const weekdayOf = (date: string): number => civil(date).getUTCDay();

/** ISO 8601 week number of a local date. */
export const isoWeek = (date: string): number => {
  const day = civil(date);
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return Math.floor((day.getTime() - yearStart) / 86_400_000 / 7) + 1;
};

/** The local date and wall-clock time of `now` in `timeZone`. */
export const localNow = (now: Date, timeZone: string): { date: string; time: string } => {
  const [date, time] = dates.instantToZonedInput(now, timeZone).split("T");
  return { date: date!, time: time! };
};

export const templateTime = (template: Pick<SpaceItemTemplate, "kind" | "timeOfDay">): string =>
  template.timeOfDay ?? (template.kind === "task" ? DEFAULT_TASK_TEMPLATE_TIME : DEFAULT_EVENT_TEMPLATE_TIME);

const toInstant = (date: string, time: string, timeZone: string): string =>
  dates.zonedDateTimeToInstant(`${date}T${time}`, timeZone, { disambiguation: "compatible" });

// ---------- Proposals ----------

/**
 * The dates a template proposes, earliest first: the next `count` matching weekdays, today plus the offset, or none.
 * For weekdays, today only counts while the template's time still lies ahead, compared as instants so a time in a
 * skipped or repeated daylight-saving hour is judged by when it really happens; an all-day event keeps today all day.
 */
export const proposeTemplateDates = (template: TemplateTiming, options: { now: Date; timeZone: string; count?: number }): string[] => {
  const rule = template.dateRule;
  const today = localNow(options.now, options.timeZone);
  if (rule.type === "none") return [];
  if (rule.type === "offset") return [addCalendarDays(today.date, rule.days)];
  const wanted = new Set(rule.weekdays.map((weekday) => WEEKDAY_INDEX[weekday]));
  const count = options.count ?? TEMPLATE_PROPOSAL_COUNT;
  const todayStillOpen =
    (template.kind === "event" && template.allDay) ||
    options.now.getTime() < new Date(toInstant(today.date, templateTime(template), options.timeZone)).getTime();
  const proposals: string[] = [];
  // Seven days hold every weekday once, so `count` matches lie within `count` weeks.
  for (let offset = todayStillOpen ? 0 : 1; proposals.length < count && offset <= count * 7; offset++) {
    const date = addCalendarDays(today.date, offset);
    if (wanted.has(weekdayOf(date))) proposals.push(date);
  }
  return proposals;
};

// ---------- Placeholders ----------

const formatLocalDate = (date: string, locale: string | undefined, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(locale ?? "en", { ...options, timeZone: "UTC" }).format(civil(date));

/** Replaces `{{date}}`, `{{weekday}}`, and `{{week}}` for `date`; unknown placeholders stay as written. */
export const resolveTemplateText = (text: string, options: { date: string; locale?: string }): string =>
  text.replace(/\{\{\s*(date|weekday|week)\s*\}\}/g, (_match, name: string) => {
    if (name === "date") return formatLocalDate(options.date, options.locale, { day: "2-digit", month: "2-digit", year: "numeric" });
    if (name === "weekday") return formatLocalDate(options.date, options.locale, { weekday: "long" });
    return String(isoWeek(options.date));
  });

/**
 * The title and description of a new item for `date`. A placeholder can be longer than the date it stands for, so
 * both stop at the item limits and every filled template stays a valid create request.
 */
export const templateText = (
  template: Pick<SpaceItemTemplate, "title" | "description">,
  options: { date: string; locale?: string },
): { title: string; description: string } => ({
  title: resolveTemplateText(template.title, options).trim().slice(0, MAX_ITEM_TITLE_LENGTH),
  description: template.description ? resolveTemplateText(template.description, options).slice(0, MAX_ITEM_DESCRIPTION_LENGTH) : "",
});

// ---------- Drafts ----------

/** The date a draft uses when the caller names none: the first proposal, today for a dateless event, none for a task. */
export const defaultTemplateDate = (template: TemplateTiming, options: { now: Date; timeZone: string }): string | null => {
  const [first] = proposeTemplateDates(template, options);
  if (first) return first;
  return template.kind === "event" ? localNow(options.now, options.timeZone).date : null;
};

/** The deadline, or the start and end, that `date` gives an item made from `template`. */
export const templateSchedule = (
  template: TemplateDraftSource,
  date: string | null,
  timeZone: string,
): Pick<TemplateItemDraft, "deadline" | "startsAt" | "endsAt" | "allDay"> => {
  if (!date) return {};
  if (template.kind === "task") return { deadline: toInstant(date, templateTime(template), timeZone) };
  if (template.allDay) {
    return { startsAt: toInstant(date, "00:00", timeZone), endsAt: toInstant(addCalendarDays(date, 1), "00:00", timeZone), allDay: true };
  }
  const startsAt = toInstant(date, templateTime(template), timeZone);
  const minutes = template.durationMinutes ?? DEFAULT_EVENT_TEMPLATE_DURATION_MINUTES;
  return { startsAt, endsAt: new Date(new Date(startsAt).getTime() + minutes * 60_000).toISOString(), allDay: false };
};

/**
 * Fills a new item from a template for one date. Placeholders use `date`, or today when the item gets no date. Only
 * fields the template sets appear, so the result works as a create request and as the starting values of a form.
 */
export const draftFromTemplate = (
  template: TemplateDraftSource,
  options: { date: string | null; timeZone: string; locale?: string; now?: Date },
): TemplateItemDraft => {
  const textDate = options.date ?? localNow(options.now ?? new Date(), options.timeZone).date;
  const { title, description } = templateText(template, { date: textDate, locale: options.locale });
  return {
    title,
    ...(description.trim() ? { description } : {}),
    ...(template.priority ? { priority: template.priority } : {}),
    tagIds: [...template.tagIds],
    assigneeIds: [...template.assigneeIds],
    assignCreator: template.assignCreator,
    checklist: template.kind === "task" ? [...template.checklist] : [],
    ...(template.kind === "task" && template.estimatedDurationMinutes
      ? { estimatedDurationMinutes: template.estimatedDurationMinutes }
      : {}),
    ...(template.kind === "event" && template.location ? { location: template.location } : {}),
    ...(template.kind === "event" && template.url ? { url: template.url } : {}),
    ...templateSchedule(template, options.date, options.timeZone),
  };
};

// ---------- Presentation ----------

const shortWeekday = (date: string, locale?: string): string => formatLocalDate(date, locale, { weekday: "short" }).replace(/\.$/, "");

/** A compact proposal label such as `Mi 14.10.` or `Wed 10/14`. */
export const formatTemplateDate = (date: string, locale?: string): string =>
  `${shortWeekday(date, locale)} ${formatLocalDate(date, locale, { day: "numeric", month: "numeric" })}`;

/** Weekday names of a rule in week order, e.g. `Mi oder Do`. */
const weekdayList = (weekdays: TemplateWeekday[], locale?: string): string => {
  const labels = WEEKDAY_ORDER.filter((weekday) => weekdays.includes(weekday)).map((weekday) =>
    // 2024-01-01 was a Monday.
    shortWeekday(addCalendarDays("2024-01-01", WEEKDAY_ORDER.indexOf(weekday)), locale),
  );
  return new Intl.ListFormat(locale ?? "en", { type: "disjunction", style: "short" }).format(labels);
};

/** The rule as one line, e.g. `Mi oder Do · 17:00`, `In 3 Tagen · 09:00`, or `Ohne Datum`. */
export const describeTemplateDateRule = (template: TemplateTiming, locale?: string): string => {
  const { t } = messages.resolve(locale ? [locale] : []);
  const rule: TemplateDateRule = template.dateRule;
  if (rule.type === "none") return t.noDate;
  const day = rule.type === "offset" ? (rule.days === 0 ? t.today : t.inDays({ days: rule.days })) : weekdayList(rule.weekdays, locale);
  const time = template.kind === "event" && template.allDay ? t.allDay : templateTime(template);
  return `${day} · ${time}`;
};
