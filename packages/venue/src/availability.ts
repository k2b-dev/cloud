import { dates } from "@k2b/stdlib";
import {
  type DateOverride,
  type OpeningRule,
  PUBLIC_EXCEPTION_DAYS,
  type PublicException,
  type PublicNow,
  type PublicOpening,
  type PublicWindow,
  type ShiftAssignment,
  type ShiftTemplate,
  type Venue,
} from "./contracts";
import { venueMessages } from "./messages";
import { formatVenueDateTime, formatVenueTimeRange } from "./time-format";

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
  now: PublicNow;
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

/** A dated shift occurs once; weekly shifts occur on their weekday. */
export const templateOccursOn = (template: Pick<ShiftTemplate, "date" | "weekday">, date: string): boolean =>
  template.date === null ? template.weekday === weekdayFor(date) : template.date === date;

/** The public page's one date and time format: `Tue, Sep 29, 11:00` and `11:00–18:00`, in the venue's time zone. */
const formatTimeRange = (opening: PublicOpening, timezone: string, locale: string): string =>
  formatVenueTimeRange(opening.startsAt, opening.endsAt, timezone, locale);

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

const isActiveAt = (opening: PublicWindow, now: Date): boolean => new Date(opening.startsAt) <= now && now < new Date(opening.endsAt);

/** Windows that touch or overlap read as one, from the first start to the last end, in time order. */
const mergeWindows = (windows: readonly PublicWindow[]): PublicWindow[] => {
  const merged: PublicWindow[] = [];
  for (const window of [...windows].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
    const last = merged.at(-1);
    if (last && Date.parse(window.startsAt) <= Date.parse(last.endsAt)) {
      if (Date.parse(window.endsAt) > Date.parse(last.endsAt)) merged[merged.length - 1] = { ...last, endsAt: window.endsAt };
    } else merged.push({ startsAt: window.startsAt, endsAt: window.endsAt });
  }
  return merged;
};

/**
 * When the venue opens on `date` whatever its shifts: a special opening, which replaces the day's regular hours
 * and opens the venue in every opening mode because an admin set it for that date on purpose, or the regular
 * hours when the opening mode uses them. A closed day has none.
 */
export const regularWindowsOn = (
  date: string,
  input: Pick<PublicAvailabilityInput, "venue" | "openingRules" | "overrides">,
): { startsAt: string; endsAt: string }[] => {
  const override = input.overrides.find((entry) => entry.date === date);
  if (override?.kind === "closed") return [];
  const windows =
    override?.kind === "open" && override.startTime && override.endTime
      ? [{ startTime: override.startTime, endTime: override.endTime }]
      : input.venue.openMode === "staffed"
        ? []
        : input.openingRules.filter((rule) => rule.weekday === weekdayFor(date));
  return windows.map((window) => ({
    startsAt: instantFor(date, window.startTime, input.venue.timezone).toISOString(),
    endsAt: instantFor(date, window.endTime, input.venue.timezone).toISOString(),
  }));
};

export const buildPublicAvailability = (input: PublicAvailabilityInput): PublicAvailability => {
  const { locale, t } = venueMessages.resolve(input.locale ? [input.locale] : []);
  const days = Math.max(1, input.days ?? 14);
  const timezone = input.venue.timezone;
  const today = dateKeyAt(input.now, timezone);
  const overridesByDate = new Map(input.overrides.map((override) => [override.date, override]));

  const regularOpenings: PublicOpening[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = dateKeyAfterDays(today, offset, timezone);
    for (const window of regularWindowsOn(date, input)) regularOpenings.push({ kind: "regular", title: t.regularHours, ...window });
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

      for (const template of activeTemplates.filter((entry) => templateOccursOn(entry, date))) {
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

  // The facts of the page's hero: the windows as visitors live them, whatever opens them.
  const windows = mergeWindows(openings);
  const windowsOn = (date: string) => windows.filter((window) => dateKeyAt(new Date(window.startsAt), timezone) === date);
  const todayLeft = windowsOn(today).filter((window) => new Date(window.endsAt) > input.now);
  const running = open ? windows.find((window) => isActiveAt(window, input.now)) : undefined;
  const exceptionToday = upcomingPublicExceptions(input.overrides, today, timezone).find((exception) => exception.date === today) ?? null;
  const now: PublicNow = {
    date: today,
    state: open ? "open" : todayLeft.some((window) => new Date(window.startsAt) > input.now) ? "later" : "closed",
    until: running?.endsAt ?? null,
    today: todayLeft,
    tomorrow: windowsOn(dateKeyAfterDays(today, 1, timezone)),
    next: windows.find((window) => dateKeyAt(new Date(window.startsAt), timezone) > today) ?? null,
    exception: exceptionToday,
    regular:
      input.venue.openMode === "staffed"
        ? []
        : input.openingRules
            .filter((rule) => rule.weekday === weekdayFor(today))
            .map((rule) => ({
              startsAt: instantFor(today, rule.startTime, timezone).toISOString(),
              endsAt: instantFor(today, rule.endTime, timezone).toISOString(),
            }))
            .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  };

  return {
    open,
    spontaneousOpen: open && !activeRegular && Boolean(activeDynamic),
    todayLabel:
      todayWindows.length > 0
        ? todayWindows.map((opening) => formatTimeRange(opening, timezone, locale)).join(", ")
        : t.noRegularHoursToday,
    nextOpeningLabel: nextOpening ? formatVenueDateTime(nextOpening.startsAt, timezone, locale) : null,
    activeWindowLabel: open && activeOpening ? formatTimeRange(activeOpening, timezone, locale) : null,
    upcomingOpenings: upcomingDynamicOpenings.filter((opening) => new Date(opening.startsAt) > input.now).slice(0, 8),
    upcomingExceptions: upcomingPublicExceptions(input.overrides, today, timezone),
    now,
  };
};
