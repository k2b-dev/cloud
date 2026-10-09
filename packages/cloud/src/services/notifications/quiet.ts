import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import type { MutationResult } from "../../contracts/shared";
import {
  type NotificationQuietHours,
  NotificationQuietHoursSchema,
  type NotificationQuietSettings,
  type NotificationQuietState,
  type UpdateNotificationQuietSettings,
} from "../../contracts/user-notifications";
import { normalizeTimeZone } from "../../shared/time";

const DAY_MS = 24 * 60 * 60_000;
/** How far ahead `until` looks. A schedule that stays quiet for longer has no end worth naming. */
const LOOKAHEAD_DAYS = 8;

type QuietInput = { doNotDisturbUntil: Date | null; quietHours: NotificationQuietHours };
type Interval = { start: number; end: number };

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * The quiet-hours intervals that touch `[from - 1 day, from + days]`, as instants. Each period belongs to the
 * local day it starts on; wall-clock times are converted per date, so a period keeps its local times across
 * daylight-saving changes. A start inside a skipped hour moves forward like the clock does.
 */
const quietHourIntervals = (hours: NotificationQuietHours, from: number, days: number): Interval[] => {
  if (hours.periods.length === 0) return [];
  const timeZone = normalizeTimeZone(hours.timeZone);
  const [localDate = ""] = dates.instantToZonedInput(new Date(from), timeZone).split("T");
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const instant = (offset: number, time: string): number => {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    const wallClock = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}T${time}`;
    return Date.parse(dates.zonedDateTimeToInstant(wallClock, timeZone, { disambiguation: "compatible" }));
  };
  const intervals: Interval[] = [];
  for (let offset = -1; offset <= days; offset += 1) {
    const isoWeekday = new Date(Date.UTC(year, month - 1, day + offset)).getUTCDay() || 7;
    for (const period of hours.periods) {
      if (!period.days.includes(isoWeekday)) continue;
      const start = instant(offset, period.start);
      const end = period.end > period.start ? instant(offset, period.end) : instant(offset + 1, period.end);
      if (end > start) intervals.push({ start, end });
    }
  }
  return intervals;
};

/**
 * Follow quiet hours from `from` across overlapping and adjoining periods. Returns `from` when it is not quiet
 * and null when the quiet time does not end within the lookahead, for example with every day fully quiet.
 */
const quietHoursEnd = (hours: NotificationQuietHours, from: number): number | null => {
  const intervals = quietHourIntervals(hours, from, LOOKAHEAD_DAYS);
  const horizon = from + LOOKAHEAD_DAYS * DAY_MS;
  let until = from;
  for (;;) {
    const ends = intervals.filter((interval) => interval.start <= until && until < interval.end).map((interval) => interval.end);
    if (ends.length === 0) return until;
    until = Math.max(...ends);
    if (until > horizon) return null;
  }
};

/**
 * Whether browser notifications are held back at `now`, why, and until when. Do not disturb names the reason
 * while it lasts; `until` also covers quiet hours that continue when it ends.
 */
export const notificationQuietState = (input: QuietInput, now: Date = new Date()): NotificationQuietState => {
  const at = now.getTime();
  const iso = (instant: number | null) => (instant === null ? null : new Date(instant).toISOString());
  const doNotDisturbUntil = input.doNotDisturbUntil?.getTime() ?? null;
  if (doNotDisturbUntil !== null && doNotDisturbUntil > at) {
    return { active: true, reason: "doNotDisturb", until: iso(quietHoursEnd(input.quietHours, doNotDisturbUntil)), nextStart: null };
  }
  const until = quietHoursEnd(input.quietHours, at);
  if (until !== at) return { active: true, reason: "quietHours", until: iso(until), nextStart: null };
  const starts = quietHourIntervals(input.quietHours, at, LOOKAHEAD_DAYS)
    .map((interval) => interval.start)
    .filter((start) => start > at && start <= at + LOOKAHEAD_DAYS * DAY_MS);
  return { active: false, reason: null, until: null, nextStart: iso(starts.length > 0 ? Math.min(...starts) : null) };
};

type QuietRow = { do_not_disturb_until: Date | null; time_zone: string; periods: unknown };

/** Parse a stored row defensively: a schedule that no longer validates silences nothing. */
export const quietInputFromRow = (row: QuietRow | undefined, fallbackTimeZone = "UTC"): QuietInput => {
  const parsed = row ? NotificationQuietHoursSchema.safeParse({ timeZone: row.time_zone, periods: row.periods }) : null;
  return {
    doNotDisturbUntil: row?.do_not_disturb_until ?? null,
    quietHours: parsed?.success ? parsed.data : { timeZone: normalizeTimeZone(row?.time_zone ?? fallbackTimeZone), periods: [] },
  };
};

const toSettings = (input: QuietInput, now = new Date()): NotificationQuietSettings => ({
  doNotDisturbUntil:
    input.doNotDisturbUntil && input.doNotDisturbUntil.getTime() > now.getTime() ? input.doNotDisturbUntil.toISOString() : null,
  quietHours: input.quietHours,
  state: notificationQuietState(input, now),
});

/** The person's quiet settings and current state. Without saved quiet hours, `fallbackTimeZone` is offered. */
const getQuietSettings = async (userId: string, fallbackTimeZone = "UTC"): Promise<NotificationQuietSettings> => {
  const [row] = await sql<QuietRow[]>`
    SELECT do_not_disturb_until, time_zone, periods FROM notifications.quiet_times WHERE user_id = ${userId}::uuid
  `;
  return toSettings(quietInputFromRow(row, fallbackTimeZone));
};

const updateQuietSettings = async (config: {
  userId: string;
  update: UpdateNotificationQuietSettings;
  fallbackTimeZone?: string;
}): Promise<MutationResult<NotificationQuietSettings>> => {
  const { doNotDisturbUntil, quietHours } = config.update;
  const until = doNotDisturbUntil ? new Date(doNotDisturbUntil) : null;
  if (until && until.getTime() <= Date.now()) {
    return { ok: false, error: "Do not disturb must end in the future", status: 400 };
  }
  const timeZone = normalizeTimeZone(quietHours?.timeZone ?? config.fallbackTimeZone);
  const periods = quietHours ? JSON.stringify(quietHours.periods) : "[]";
  await sql`
    INSERT INTO notifications.quiet_times (user_id, do_not_disturb_until, time_zone, periods, updated_at)
    VALUES (${config.userId}::uuid, ${until}::timestamptz, ${timeZone}, (${periods}::text)::jsonb, now())
    ON CONFLICT (user_id) DO UPDATE SET
      do_not_disturb_until = CASE WHEN ${doNotDisturbUntil !== undefined} THEN EXCLUDED.do_not_disturb_until
        ELSE notifications.quiet_times.do_not_disturb_until END,
      time_zone = CASE WHEN ${quietHours !== undefined} THEN EXCLUDED.time_zone ELSE notifications.quiet_times.time_zone END,
      periods = CASE WHEN ${quietHours !== undefined} THEN EXCLUDED.periods ELSE notifications.quiet_times.periods END,
      updated_at = now()
  `;
  return { ok: true, data: await getQuietSettings(config.userId, config.fallbackTimeZone) };
};

/** The quiet state of an event's recipient, or null when the recipient is not a Cloud user. */
export const quietStateForEvent = async (eventId: string, now = new Date()): Promise<NotificationQuietState | null> => {
  const [row] = await sql<QuietRow[]>`
    SELECT q.do_not_disturb_until, q.time_zone, q.periods
    FROM notifications.events e
    JOIN notifications.quiet_times q ON q.user_id = e.recipient_user_id
    WHERE e.id = ${eventId}::uuid
  `;
  return row ? notificationQuietState(quietInputFromRow(row), now) : null;
};

export const userQuietTimes = { get: getQuietSettings, update: updateQuietSettings } as const;
