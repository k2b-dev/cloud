import { type DateContext, dates } from "@k2b/stdlib";
import { coreSettings } from "@k2b/cloud/services";
import { sql } from "bun";
import icalGenerator, { ICalEventRepeatingFreq, type ICalRepeatingOptions, ICalWeekday } from "ical-generator";
import type { Priority } from "@/contracts";
import { buildSpaceCalendarUid } from "../routes";

// ==========================
// iCal Service
// ==========================

type DbSpace = {
  id: string;
  short_id: string;
  name: string;
  description: string | null;
  color: string;
  ical_token: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbItem = {
  id: string;
  short_id: string;
  title: string;
  description: string | null;
  location: string | null;
  url: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  all_day: boolean;
  deadline: Date | null;
  priority: string | null;
  recurrence_rrule: string | null;
  recurrence_dtstart: Date | null;
  recurrence_exdate: Date[] | null;
  recurring_event_id: string | null;
  recurring_event_short_id: string | null;
  recurrence_id: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ICalFeedItem = {
  id: string;
  shortId: string;
  title: string;
  description: string | null;
  location: string | null;
  url: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allDay: boolean;
  deadline: Date | null;
  priority: Priority | null;
  recurrenceRrule: string | null;
  recurrenceDtstart: Date | null;
  recurrenceExdate: Date[];
  recurringEventId: string | null;
  recurringEventShortId: string | null;
  recurrenceId: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Converts one space row into the shared `Space` type for iCal token lookup and feed metadata.
 */
const mapToSpace = (row: DbSpace) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  color: row.color,
  icalToken: row.ical_token,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapItem = (row: DbItem): ICalFeedItem => ({
  id: row.id,
  shortId: row.short_id,
  title: row.title,
  description: row.description,
  location: row.location,
  url: row.url,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  allDay: row.all_day,
  deadline: row.deadline,
  priority: row.priority as Priority | null,
  recurrenceRrule: row.recurrence_rrule,
  recurrenceDtstart: row.recurrence_dtstart,
  recurrenceExdate: row.recurrence_exdate ?? [],
  recurringEventId: row.recurring_event_id,
  recurringEventShortId: row.recurring_event_short_id,
  recurrenceId: row.recurrence_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Get a space by its iCal token
 */
export const getByToken = async (params: { token: string }): Promise<ReturnType<typeof mapToSpace> | null> => {
  const [row] = await sql<DbSpace[]>`
    SELECT id, short_id, name, description, color, ical_token, created_at, updated_at
    FROM spaces.spaces
    WHERE ical_token = ${params.token}
  `;
  return row ? mapToSpace(row) : null;
};

const parseRrule = (rrule: string): Record<string, string> =>
  Object.fromEntries(
    rrule
      .split(";")
      .map((part) => part.split("="))
      .filter((part): part is [string, string] => Boolean(part[0] && part[1]))
      .map(([key, value]) => [key.toUpperCase(), value]),
  );

const parseUntil = (value: string): Date | undefined => {
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    return new Date(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
    );
  }
  if (/^\d{8}$/.test(value)) {
    return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T23:59:59.999Z`);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const toRepeatingOptions = (item: ICalFeedItem): ICalRepeatingOptions | undefined => {
  if (!item.recurrenceRrule) return undefined;
  const parts = parseRrule(item.recurrenceRrule);
  const freq = parts.FREQ as keyof typeof ICalEventRepeatingFreq | undefined;
  if (!freq || !ICalEventRepeatingFreq[freq]) return undefined;

  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : undefined;
  const count = parts.COUNT ? Number(parts.COUNT) : undefined;
  const until = parts.UNTIL ? parseUntil(parts.UNTIL) : undefined;
  const byDay = parts.BYDAY?.split(",")
    .map((day) => ICalWeekday[day as keyof typeof ICalWeekday])
    .filter((day): day is ICalWeekday => Boolean(day));

  return {
    freq: ICalEventRepeatingFreq[freq],
    interval: interval && Number.isFinite(interval) ? interval : undefined,
    count: count && Number.isFinite(count) ? count : undefined,
    until,
    byDay: byDay && byDay.length > 0 ? byDay : undefined,
    exclude: item.recurrenceExdate.length > 0 ? item.recurrenceExdate : undefined,
    startOfWeek: ICalWeekday.MO,
  };
};

const eventUrl = (baseUrl: string, spaceId: string, item: ICalFeedItem): string =>
  item.url ?? `${baseUrl}/app/spaces/${spaceId}?view=calendar&item=${item.shortId}`;

export const createICalContent = async (params: {
  space: DbSpace;
  items: ICalFeedItem[];
  baseUrl: string;
  appName?: string | null;
  dateConfig?: DateContext;
}): Promise<string> => {
  const timezone = dates.normalizeTimeZone(params.dateConfig?.timeZone ?? (await coreSettings.get<string>("app.timezone")), "UTC");
  const calendar = icalGenerator({
    name: params.space.name,
    description: params.space.description ?? undefined,
    prodId: {
      company: params.appName || (await coreSettings.get<string>("app.name")) || "App",
      product: "Spaces",
      language: "DE",
    },
    timezone,
  });

  for (const item of params.items) {
    if (item.startsAt && item.endsAt) {
      calendar.createEvent({
        id: buildSpaceCalendarUid(item.recurringEventShortId ?? item.shortId),
        start: item.recurrenceDtstart ?? item.startsAt,
        end: item.endsAt,
        allDay: item.allDay,
        timezone,
        repeating: toRepeatingOptions(item),
        recurrenceId: item.recurrenceId ?? undefined,
        summary: item.title,
        description: item.description ?? undefined,
        location: item.location ?? undefined,
        url: eventUrl(params.baseUrl, params.space.short_id, item),
        created: item.createdAt,
        lastModified: item.updatedAt,
        priority: priorityToIcal(item.priority),
      });
    } else if (item.deadline) {
      calendar.createEvent({
        id: buildSpaceCalendarUid(item.shortId),
        start: item.deadline,
        allDay: true,
        timezone,
        summary: `[Deadline] ${item.title}`,
        description: item.description ?? undefined,
        location: item.location ?? undefined,
        url: eventUrl(params.baseUrl, params.space.short_id, item),
        created: item.createdAt,
        lastModified: item.updatedAt,
        priority: priorityToIcal(item.priority),
      });
    }
  }

  return calendar.toString();
};

/**
 * Generate iCal content for a space
 */
export const generate = async (params: { spaceId: string; baseUrl: string; dateConfig?: DateContext }): Promise<string> => {
  // Get space
  const [space] = await sql<DbSpace[]>`
    SELECT id, short_id, name, description, color, ical_token, created_at, updated_at
    FROM spaces.spaces
    WHERE id = ${params.spaceId}
  `;

  if (!space) {
    throw new Error("Space not found");
  }

  // Get all non-completed items with time data
  const rows = await sql<DbItem[]>`
    SELECT item.id, item.short_id, item.title, item.description, item.location, item.url, item.starts_at, item.ends_at,
           item.all_day, item.deadline, item.priority, item.recurrence_rrule, item.recurrence_dtstart, item.recurrence_exdate,
           item.recurring_event_id, recurring.short_id AS recurring_event_short_id, item.recurrence_id,
           item.created_at, item.updated_at
    FROM spaces.items item
    LEFT JOIN spaces.items recurring ON recurring.id = item.recurring_event_id
    WHERE item.space_id = ${params.spaceId}
      AND item.completed_at IS NULL
      AND (item.starts_at IS NOT NULL OR item.deadline IS NOT NULL)
    ORDER BY COALESCE(item.starts_at, item.deadline)
  `;

  return createICalContent({
    space,
    items: rows.map(mapItem),
    baseUrl: params.baseUrl,
    dateConfig: params.dateConfig,
  });
};

/**
 * Convert priority to iCal priority (1-9, where 1 is highest)
 */
const priorityToIcal = (priority: Priority | null): number | undefined => {
  switch (priority) {
    case "urgent":
      return 1;
    case "high":
      return 3;
    case "medium":
      return 5;
    case "low":
      return 9;
    default:
      return undefined;
  }
};
