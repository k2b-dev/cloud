import { lazySync } from "@k2b/cloud";
import { getEffectivePermission, hasPermission, listUsersWithAccess } from "@k2b/cloud/server";
import { coreSettings, logger, notifications } from "@k2b/cloud/services";
import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import { regularWindowsOn } from "./availability";
import { app } from "./config";
import type { DateOverride, OpeningRule, ShiftTemplate, Venue } from "./contracts";
import { type CancelledAssignment, type UpcomingSlotSummary, venueService } from "./service";
import { publicIds } from "./service/public-resources";

/**
 * Staff reminders and the notices to a venue's admins about cancellations and gaps. Notices go out through the
 * platform notifications, so recipients choose their channels in their notification preferences, and the
 * platform's idempotency keeps each notice to one event per recipient: no Venue table records what was sent.
 */

const log = logger("venue:notices");

/** Reminders go out about this long before a shift, and gaps are reported for shifts starting within it. */
export const NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Venues and sign-ups per query in a scan; the scan renews its lease after each batch. */
export const NOTICE_SCAN_BATCH_SIZE = 100;
/** The ceiling of `listUsersWithAccess`: the admins of one venue that a notice reaches. */
const ADMIN_RECIPIENT_LIMIT = 500;

/** Idempotency keys: one event per sign-up, slot, or cancellation, and per recipient. */
export const noticeKeys = {
  reminder: (assignmentId: string, startsAt: string) => `venue:reminder:${assignmentId}:${startsAt}`,
  understaffed: (templateId: string, date: string, userId: string) => `venue:understaffed:${templateId}:${date}:${userId}`,
  cancelled: (assignmentId: string) => `venue:cancelled:${assignmentId}`,
};

export type NoticeWindow = { from: Date; to: Date };

/** The shifts a scan at `now` looks at: those that start after `now` and at most 24 hours later. */
export const noticeWindow = (now: Date): NoticeWindow => ({ from: now, to: new Date(now.getTime() + NOTICE_WINDOW_MS) });

export const isInNoticeWindow = (startsAt: string, window: NoticeWindow): boolean => {
  const time = Date.parse(startsAt);
  return time > window.from.getTime() && time <= window.to.getTime();
};

const dayNumber = (dateKey: string): number => Date.parse(`${dateKey}T00:00:00Z`) / 86_400_000;
/** Date keys name a day, so plain UTC arithmetic counts them exactly. */
const dateKeyAfter = (dateKey: string, days: number): string =>
  new Date((dayNumber(dateKey) + days) * 86_400_000).toISOString().slice(0, 10);

/**
 * The local days of the venue that the window touches, for the slot computation. A window that crosses a
 * short night, when clocks move forward, can touch three days.
 */
export const noticeWindowDays = (window: NoticeWindow, timezone: string): { startDate: string; days: number } => {
  const startDate = dates.formatDateKey(window.from, { timeZone: timezone });
  const endDate = dates.formatDateKey(window.to, { timeZone: timezone });
  return { startDate, days: dayNumber(endDate) - dayNumber(startDate) + 1 };
};

/**
 * A reminder is due from 24 hours before the shift until it starts, for sign-ups that existed 24 hours before
 * it: someone who takes a shift at shorter notice knows about it and gets no reminder.
 */
export const isReminderDue = (assignment: { startsAt: string; createdAt: string }, now: Date): boolean => {
  const startsAt = Date.parse(assignment.startsAt);
  const dueAt = startsAt - NOTICE_WINDOW_MS;
  return startsAt > now.getTime() && dueAt <= now.getTime() && Date.parse(assignment.createdAt) <= dueAt;
};

/**
 * Whether a gap keeps the venue closed for the shift: the shift opens the venue only once it is staffed, and
 * neither regular hours nor a special opening open it during the shift anyway.
 */
export const isClosedUnlessStaffed = (
  slot: Pick<UpcomingSlotSummary, "date" | "startsAt" | "endsAt"> & { template: Pick<ShiftTemplate, "requireTargetForOpening"> },
  schedule: { venue: Pick<Venue, "openMode" | "timezone">; openingRules: OpeningRule[]; overrides: DateOverride[] },
): boolean =>
  slot.template.requireTargetForOpening &&
  schedule.venue.openMode !== "regular" &&
  !regularWindowsOn(slot.date, schedule).some(
    (window) => Date.parse(window.startsAt) < Date.parse(slot.endsAt) && Date.parse(window.endsAt) > Date.parse(slot.startsAt),
  );

/** The people a notice to the venue's admins reaches: each admin once, without the person who acted. */
export const noticeRecipients = (admins: readonly { id: string }[], actorUserId: string | null): string[] =>
  [...new Set(admins.map((admin) => admin.id))].filter((id) => id !== actorUserId);

const venueAccessIds = async (venueId: string): Promise<string[]> =>
  (await sql<{ access_id: string }[]>`SELECT access_id FROM venue.venue_access WHERE venue_id = ${venueId}::uuid`).map(
    (row) => row.access_id,
  );

/** Admins through direct and group grants; grants to everyone signed in or the public name no one. */
const venueAdmins = async (accessIds: string[]) =>
  listUsersWithAccess({ accessIds, minimumPermission: "admin", limit: ADMIN_RECIPIENT_LIMIT });

const operatorLocale = () => coreSettings.get<string>("app.locale");

/**
 * Sends one notice. `existing` means an earlier send created the event already. A failure is logged and
 * reported, so one recipient never stops the others.
 */
const attempt = async (
  kind: string,
  context: Record<string, string>,
  send: () => Promise<{ created: boolean }>,
): Promise<"created" | "existing" | "failed"> => {
  try {
    return (await send()).created ? "created" : "existing";
  } catch (error) {
    log.error("Venue notification failed", { kind, ...context, error: error instanceof Error ? error.message : String(error) });
    return "failed";
  }
};

const count = (summary: NoticeScanSummary, key: "reminders" | "understaffed", outcome: "created" | "existing" | "failed") => {
  if (outcome === "created") summary[key]++;
  if (outcome === "failed") summary.failed++;
};

/**
 * Tells the venue's admins, except the person who acted, that someone left an upcoming shift or was removed
 * from it. Runs after the cancellation committed; a failure is logged and never undoes the cancellation. The
 * gap scan reports a shift that still misses people once it starts within 24 hours.
 */
export const notifyShiftCancelled = async (input: {
  venue: Pick<Venue, "id" | "name" | "timezone">;
  cancelled: CancelledAssignment;
  actor: { id: string; uid: string; displayName: string };
  now?: Date;
}): Promise<void> => {
  const { venue, cancelled, actor } = input;
  if (Date.parse(cancelled.startsAt) <= (input.now ?? new Date()).getTime()) return;
  try {
    const [accessIds, venueIds, locale] = await Promise.all([venueAccessIds(venue.id), publicIds("venues", [venue.id]), operatorLocale()]);
    const recipients = noticeRecipients(await venueAdmins(accessIds), actor.id);
    const venueId = venueIds.get(venue.id);
    if (!venueId || recipients.length === 0) return;
    const data = {
      venueId,
      venueName: venue.name,
      timezone: venue.timezone,
      shiftTitle: cancelled.templateTitle,
      startsAt: cancelled.startsAt,
      endsAt: cancelled.endsAt,
      templateId: cancelled.templateId,
      person: cancelled.userDisplayName,
      removedBy: actor.id === cancelled.userId ? null : actor.displayName || actor.uid,
    };
    for (const userId of recipients) {
      await attempt("shiftCancelled", { venueId: venue.id, assignmentId: cancelled.id, userId }, () =>
        notifications.send(app.notifications.shiftCancelled, {
          recipient: { userId },
          data,
          idempotencyKey: noticeKeys.cancelled(cancelled.id),
          locale,
          sentBy: actor.id,
        }),
      );
    }
  } catch (error) {
    log.error("Venue cancellation notice failed", {
      venueId: venue.id,
      assignmentId: cancelled.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export type NoticeScanSummary = {
  venues: number;
  /** New reminder events; a reminder an earlier scan sent does not count again. */
  reminders: number;
  /** New gap notices, one per slot and admin. */
  understaffed: number;
  /** Due reminders to people who no longer have staff access to the venue. */
  withoutAccess: number;
  failed: number;
};

type NoticeScan = {
  now: Date;
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
  batchSize?: number;
};

type ScanState = NoticeScan & { window: NoticeWindow; locale: string; batchSize: number; summary: NoticeScanSummary };

const closedDatesOf = (overrides: DateOverride[]): Set<string> =>
  new Set(overrides.filter((override) => override.kind === "closed").map((override) => override.date));

type ReminderRow = {
  id: string;
  short_id: string;
  user_id: string;
  starts_at: Date;
  ends_at: Date;
  created_at: Date;
  template_title: string | null;
};

/**
 * Due reminders for sign-ups of shifts that still run: free time and active shifts. A paused or deleted shift
 * plans no slot and opens nothing, so its sign-ups get no reminder, just as a closed day's.
 */
const scanReminders = async (venue: Venue, venueId: string, accessIds: string[], closedDates: Set<string>, scan: ScanState) => {
  const canWork = new Map<string, boolean>();
  let cursor: { startsAt: Date; id: string } | null = null;
  for (;;) {
    scan.signal?.throwIfAborted();
    const rows: ReminderRow[] = await sql<ReminderRow[]>`
      SELECT sa.id, sa.short_id, sa.user_id, sa.starts_at, sa.ends_at, sa.created_at, st.title AS template_title
      FROM venue.shift_assignments sa
      LEFT JOIN venue.shift_templates st ON st.id = sa.template_id
      WHERE sa.venue_id = ${venue.id}::uuid
        AND (sa.template_id IS NULL OR st.active)
        AND sa.starts_at > ${scan.window.from}
        AND sa.starts_at <= ${scan.window.to}
        AND (${cursor?.startsAt ?? null}::timestamptz IS NULL OR (sa.starts_at, sa.id) > (${cursor?.startsAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      ORDER BY sa.starts_at, sa.id
      LIMIT ${scan.batchSize}
    `;
    for (const row of rows) {
      const startsAt = row.starts_at.toISOString();
      if (!isReminderDue({ startsAt, createdAt: row.created_at.toISOString() }, scan.now)) continue;
      if (closedDates.has(dates.formatDateKey(row.starts_at, { timeZone: venue.timezone }))) continue;
      let allowed = canWork.get(row.user_id);
      if (allowed === undefined) {
        allowed = hasPermission(await getEffectivePermission({ accessIds, subject: { type: "user", userId: row.user_id } }), "write");
        canWork.set(row.user_id, allowed);
      }
      if (!allowed) {
        scan.summary.withoutAccess++;
        continue;
      }
      const outcome = await attempt("shiftReminder", { venueId: venue.id, assignmentId: row.id }, () =>
        notifications.send(app.notifications.shiftReminder, {
          recipient: { userId: row.user_id },
          data: {
            venueId,
            venueName: venue.name,
            timezone: venue.timezone,
            shiftTitle: row.template_title,
            startsAt,
            endsAt: row.ends_at.toISOString(),
            assignmentId: row.short_id,
          },
          idempotencyKey: noticeKeys.reminder(row.id, startsAt),
          locale: scan.locale,
        }),
      );
      count(scan.summary, "reminders", outcome);
    }
    await scan.heartbeat?.();
    const last = rows.at(-1);
    if (!last || rows.length < scan.batchSize) return;
    cursor = { startsAt: last.starts_at, id: last.id };
  }
};

const scanGaps = async (venue: Venue, venueId: string, accessIds: string[], overrides: DateOverride[], scan: ScanState) => {
  // Where staff only add free time, recurring shifts take no sign-ups and would always miss people.
  if (venue.signupMode === "free") return;
  const { startDate, days } = noticeWindowDays(scan.window, venue.timezone);
  // The schedule's own slot computation: paused shifts plan no slots.
  const slots = await venueService.shifts.listSummary(venue, { startDate, days });
  const closedDates = closedDatesOf(overrides);
  const gaps = slots.filter(
    (slot) => slot.missingPeople > 0 && !closedDates.has(slot.date) && isInNoticeWindow(slot.startsAt, scan.window),
  );
  if (gaps.length === 0) return;
  const [admins, templateIds, openingRules] = await Promise.all([
    venueAdmins(accessIds),
    publicIds(
      "templates",
      gaps.map((slot) => slot.template.id),
    ),
    venueService.openingRules.list(venue.id),
  ]);
  const recipients = noticeRecipients(admins, null);
  let sent = 0;
  for (const slot of gaps) {
    const templateId = templateIds.get(slot.template.id);
    if (!templateId) continue;
    const data = {
      venueId,
      venueName: venue.name,
      timezone: venue.timezone,
      shiftTitle: slot.template.title,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      templateId,
      assignedCount: slot.assignedCount,
      minPeople: slot.minPeople,
      maxPeople: slot.maxPeople,
      blocksOpening: isClosedUnlessStaffed(slot, { venue, openingRules, overrides }),
    };
    for (const userId of recipients) {
      scan.signal?.throwIfAborted();
      const outcome = await attempt("shiftUnderstaffed", { venueId: venue.id, templateId: slot.template.id, userId }, () =>
        notifications.send(app.notifications.shiftUnderstaffed, {
          recipient: { userId },
          data,
          idempotencyKey: noticeKeys.understaffed(slot.template.id, slot.date, userId),
          locale: scan.locale,
        }),
      );
      count(scan.summary, "understaffed", outcome);
      // Slots times admins can run long: renew the lease after each batch of notices, as the reminders do.
      if (++sent % scan.batchSize === 0) await scan.heartbeat?.();
    }
  }
};

const scanVenue = async (id: string, venueId: string, scan: ScanState) => {
  const venue = await venueService.venues.getSummary(id);
  if (!venue) return;
  const { startDate, days } = noticeWindowDays(scan.window, venue.timezone);
  const [accessIds, overrides] = await Promise.all([
    venueAccessIds(venue.id),
    venueService.overrides.listRange(venue.id, startDate, dateKeyAfter(startDate, days)),
  ]);
  scan.summary.venues++;
  await scanReminders(venue, venueId, accessIds, closedDatesOf(overrides), scan);
  await scanGaps(venue, venueId, accessIds, overrides, scan);
};

/**
 * One scan of the next 24 hours across all venues that have sign-ups or staffed shifts: reminders for due
 * sign-ups and one notice per understaffed slot. Closed days and paused or deleted shifts produce nothing.
 * Repeating a scan, or two overlapping scans, send nothing twice, because every notice has a stable
 * idempotency key.
 */
export const runShiftNotices = async (input: NoticeScan): Promise<NoticeScanSummary> => {
  const scan: ScanState = {
    ...input,
    window: noticeWindow(input.now),
    locale: await operatorLocale(),
    batchSize: Math.max(1, input.batchSize ?? NOTICE_SCAN_BATCH_SIZE),
    summary: { venues: 0, reminders: 0, understaffed: 0, withoutAccess: 0, failed: 0 },
  };
  let cursor: string | null = null;
  for (;;) {
    scan.signal?.throwIfAborted();
    const rows: { id: string; short_id: string }[] = await sql<{ id: string; short_id: string }[]>`
      SELECT v.id, v.short_id
      FROM venue.venues v
      WHERE (${cursor}::uuid IS NULL OR v.id > ${cursor}::uuid)
        AND (
          EXISTS (
            SELECT 1 FROM venue.shift_assignments sa
            WHERE sa.venue_id = v.id AND sa.starts_at > ${scan.window.from} AND sa.starts_at <= ${scan.window.to}
          )
          OR (
            v.signup_mode <> 'free'
            AND EXISTS (SELECT 1 FROM venue.shift_templates st WHERE st.venue_id = v.id AND st.active AND st.min_people > 0)
          )
        )
      ORDER BY v.id
      LIMIT ${scan.batchSize}
    `;
    for (const row of rows) {
      scan.signal?.throwIfAborted();
      await scanVenue(row.id, row.short_id, scan);
      await scan.heartbeat?.();
    }
    const last = rows.at(-1);
    if (!last || rows.length < scan.batchSize) return scan.summary;
    cursor = last.id;
  }
};

const venueScheduler = lazySync((sync) => sync.scheduler({ id: "venue", delivery: { maxAttempts: 3, backoffMs: [10_000, 60_000] } }));
let worker: Awaited<ReturnType<ReturnType<typeof venueScheduler>["process"]>> | undefined;

/** The Venue scheduler: every 15 minutes, one scan; a missed run is made up once, by the newest slot only. */
export const shiftNoticeScheduler = {
  start: async (): Promise<void> => {
    if (worker) return;
    await venueScheduler().create({
      id: "venue:shift-notices",
      cron: "*/15 * * * *",
      timezone: "UTC",
      misfire: "latest",
      meta: { appId: "venue", family: "notifications", label: "Shift reminders and staffing notices" },
      process: async (context) => {
        // The window starts now, not at the slot: a delayed run must not remind anyone of a shift that started.
        const summary = await runShiftNotices({ now: new Date(), signal: context.signal, heartbeat: () => context.heartbeat() });
        if (summary.reminders + summary.understaffed + summary.failed > 0) log.info("Venue shift notices sent", summary);
      },
    });
    worker = await venueScheduler().process();
  },
  stop: async (): Promise<void> => {
    const current = worker;
    worker = undefined;
    if (!current) return;
    current.stop();
    await current.drain();
  },
};
