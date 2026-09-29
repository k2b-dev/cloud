import { dates } from "@k2b/stdlib";
import {
  type DateOverride,
  type OpeningRule,
  PUBLIC_EXCEPTION_DAYS,
  type PublicException,
  type PublicOpening,
  type ShiftAssignment,
  type ShiftTemplate,
  type Venue,
} from "./contracts";
import { venueMessages } from "./messages";

type PublicAvailabilityInput = {
  venue: Pick<Venue, "openMode" | "timezone">;
  openingRules: OpeningRule[];
  overrides: DateOverride[];
  templates: ShiftTemplate[];
  assignments: Array<
    Pick<ShiftAssignment, "templateId" | "startsAt" | "endsAt"> & {
      assignedCount?: number;
    }
  >;
  now: Date;
  days?: number;
  locale?: string;
};

export type PublicAvailability = {
  open: boolean;
  spontaneousOpen: boolean;
  todayLabel: string;
  nextOpeningLabel: string | null;
  activeWindowLabel: string | null;
  upcomingOpenings: PublicOpening[];
  upcomingExceptions: PublicException[];
};

const dateKeyAt = (instant: Date, timezone: string): string => dates.formatDateKey(instant, { timeZone: timezone });

/** The instant of a venue clock time on `date`; `24:00` ends the day, at the next day's midnight. */
const instantFor = (date: string, time: string, timezone: string): Date =>
  time === "24:00"
    ? instantFor(dateKeyAfterDays(date, 1, timezone), "00:00", timezone)
    : new Date(dates.zonedDateTimeToInstant(`${date}T${time}`, timezone, { disambiguation: "compatible" }));

const dateKeyAfterDays = (date: string, days: number, timezone: string): string =>
  dates.formatDateKey(new Date(instantFor(date, "12:00", timezone).getTime() + days * 86_400_000), { timeZone: timezone });

const weekdayFor = (dateKey: string): number => new Date(`${dateKey}T12:00:00Z`).getUTCDay();

const formatDateTime = (iso: string, timezone: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

const formatTimeRange = (opening: PublicOpening, timezone: string, locale: string): string => {
  const formatter = new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${formatter.format(new Date(opening.startsAt))}-${formatter.format(new Date(opening.endsAt))}`;
};

const exactOpeningKey = (opening: PublicOpening): string => `${opening.startsAt}:${opening.endsAt}`;

const deduplicateOpenings = (openings: PublicOpening[]): PublicOpening[] => {
  const unique = new Map<string, PublicOpening>();
  for (const opening of openings) {
    const key = exactOpeningKey(opening);
    if (!unique.has(key)) unique.set(key, opening);
  }
  return [...unique.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.endsAt.localeCompare(b.endsAt));
};

/**
 * The exceptions visitors see in advance: closed days and special openings from `today` through the following
 * {@link PUBLIC_EXCEPTION_DAYS} days minus one, in date order. `today` is a date key in the Venue's time zone.
 */
export const upcomingPublicExceptions = (overrides: DateOverride[], today: string, timezone: string): PublicException[] => {
  const end = dateKeyAfterDays(today, PUBLIC_EXCEPTION_DAYS, timezone);
  return overrides
    .filter((override) => override.date >= today && override.date < end)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((override) => ({
      date: override.date,
      kind: override.kind,
      startTime: override.kind === "open" ? override.startTime : null,
      endTime: override.kind === "open" ? override.endTime : null,
      note: override.note,
    }));
};

const isActiveAt = (opening: PublicOpening, now: Date): boolean => new Date(opening.startsAt) <= now && now < new Date(opening.endsAt);

export const buildPublicAvailability = (input: PublicAvailabilityInput): PublicAvailability => {
  const { locale, t } = venueMessages.resolve(input.locale ? [input.locale] : []);
  const days = Math.max(1, input.days ?? 14);
  const timezone = input.venue.timezone;
  const today = dateKeyAt(input.now, timezone);
  const overridesByDate = new Map(input.overrides.map((override) => [override.date, override]));
  const rulesByWeekday = new Map<number, OpeningRule[]>();
  for (const rule of input.openingRules) {
    const entries = rulesByWeekday.get(rule.weekday);
    if (entries) entries.push(rule);
    else rulesByWeekday.set(rule.weekday, [rule]);
  }

  // A special opening replaces the day's regular hours and opens the venue in every opening mode: an admin set
  // it for that date on purpose. Regular hours count only when the opening mode uses them.
  const regularOpenings: PublicOpening[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = dateKeyAfterDays(today, offset, timezone);
    const override = overridesByDate.get(date);
    if (override?.kind === "closed") continue;

    const windows =
      override?.kind === "open" && override.startTime && override.endTime
        ? [{ startTime: override.startTime, endTime: override.endTime }]
        : input.venue.openMode === "staffed"
          ? []
          : (rulesByWeekday.get(weekdayFor(date)) ?? []);

    for (const window of windows) {
      regularOpenings.push({
        kind: "regular",
        title: t.regularHours,
        startsAt: instantFor(date, window.startTime, timezone).toISOString(),
        endsAt: instantFor(date, window.endTime, timezone).toISOString(),
      });
    }
  }

  const dynamicOpenings: PublicOpening[] = [];
  if (input.venue.openMode !== "regular") {
    const assignmentsByTemplateStart = new Map<string, number>();
    for (const assignment of input.assignments) {
      if (!assignment.templateId) continue;
      const key = `${assignment.templateId}:${assignment.startsAt}`;
      assignmentsByTemplateStart.set(key, (assignmentsByTemplateStart.get(key) ?? 0) + (assignment.assignedCount ?? 1));
    }

    const activeTemplates = input.templates.filter((template) => template.active);
    for (let offset = 0; offset < days; offset++) {
      const date = dateKeyAfterDays(today, offset, timezone);
      if (overridesByDate.get(date)?.kind === "closed") continue;

      for (const template of activeTemplates.filter((entry) => entry.weekday === weekdayFor(date))) {
        const startsAt = instantFor(date, template.startTime, timezone).toISOString();
        const assignedCount = assignmentsByTemplateStart.get(`${template.id}:${startsAt}`) ?? 0;
        const qualifies = template.requireTargetForOpening ? assignedCount >= Math.max(1, template.minPeople) : assignedCount > 0;
        if (!qualifies) continue;

        // Template titles are internal shift names; visitors see only that the venue is additionally open.
        dynamicOpenings.push({
          kind: "shift",
          title: t.additionalOpening,
          startsAt,
          endsAt: instantFor(date, template.endTime, timezone).toISOString(),
        });
      }
    }

    for (const assignment of input.assignments) {
      if (assignment.templateId) continue;
      const assignmentDate = dateKeyAt(new Date(assignment.startsAt), timezone);
      if (overridesByDate.get(assignmentDate)?.kind === "closed") continue;
      dynamicOpenings.push({
        kind: "free",
        title: t.additionalOpening,
        startsAt: assignment.startsAt,
        endsAt: assignment.endsAt,
      });
    }
  }

  const openings = deduplicateOpenings([...regularOpenings, ...dynamicOpenings]);
  const upcomingDynamicOpenings = deduplicateOpenings(dynamicOpenings);
  const closedToday = overridesByDate.get(today)?.kind === "closed";
  const activeRegular = regularOpenings.find((opening) => isActiveAt(opening, input.now));
  const activeDynamic = dynamicOpenings.find((opening) => isActiveAt(opening, input.now));
  const activeOpening = activeRegular ?? activeDynamic;
  const open = !closedToday && Boolean(activeOpening);
  const todayWindows = regularOpenings.filter((opening) => dateKeyAt(new Date(opening.startsAt), timezone) === today);
  const nextOpening = openings.find((opening) => new Date(opening.startsAt) > input.now);

  return {
    open,
    spontaneousOpen: open && !activeRegular && Boolean(activeDynamic),
    todayLabel:
      todayWindows.length > 0
        ? todayWindows.map((opening) => formatTimeRange(opening, timezone, locale)).join(", ")
        : t.noRegularHoursToday,
    nextOpeningLabel: nextOpening ? formatDateTime(nextOpening.startsAt, timezone, locale) : null,
    activeWindowLabel: open && activeOpening ? formatTimeRange(activeOpening, timezone, locale) : null,
    upcomingOpenings: upcomingDynamicOpenings.filter((opening) => new Date(opening.startsAt) > input.now).slice(0, 8),
    upcomingExceptions: upcomingPublicExceptions(input.overrides, today, timezone),
  };
};
